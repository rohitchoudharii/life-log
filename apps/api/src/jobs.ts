import { sectionText } from '@peak/core'
import { GENERATE_QUESTIONS_PROMPT_VERSION, linkSections, planBatches, providers, writeQuestions, type GeneratedQuestion } from '@peak/llm'
import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm'
import { PgBoss } from 'pg-boss'
import { decryptSecret } from './crypto'
import { db, t } from './db'
import { env } from './env'

/**
 * One job per item writes whatever its sections need. The stately policy allows one running and
 * one waiting job per item, so chapters picked while a job runs are written by the next one.
 */
const QUEUE = 'write-questions'
const OLD_QUEUE = 'generate-questions'
const boss = new PgBoss(env.DATABASE_URL)

export async function startJobs() {
	boss.on('error', (err) => console.error('[jobs]', err))
	await boss.start()
	// Workers send heartbeats, so a job whose process died (a restart, a deploy) is retried within
	// half a minute instead of blocking its item until it expires.
	const options = { retryLimit: 2, retryDelay: 30, retryBackoff: true, expireInSeconds: 60 * 60, heartbeatSeconds: 30 }
	if (await boss.getQueue(QUEUE)) await boss.updateQueue(QUEUE, options)
	else await boss.createQueue(QUEUE, { policy: 'stately', ...options })
	// Different items are written side by side; one item's jobs never overlap (stately, per item).
	await boss.work<{ itemId: string }>(QUEUE, { localConcurrency: 3 }, async ([job]) => {
		if (job) await generateForItem(job.data.itemId)
	})
	// Items left mid-way by a restart or by the old queue (whose 15-minute limit cut long items short).
	if (await boss.getQueue(OLD_QUEUE)) await boss.deleteQueue(OLD_QUEUE)
	const stuck = await db.select({ id: t.contentItems.id }).from(t.contentItems).where(eq(t.contentItems.status, 'processing'))
	await Promise.all(stuck.map((i) => enqueueGeneration(i.id)))
}

export const enqueueGeneration = (itemId: string) => boss.send(QUEUE, { itemId }, { singletonKey: itemId })

/** Readings longer than this get questions chapter by chapter, when a chapter is picked. */
export const ON_DEMAND_WORDS = 8000

/**
 * Pre-generates questions for an item so tests never wait on the model. Sections are sent in
 * batches of whole chapters; when it takes more than one batch, a last call writes questions that
 * link sections across batches. Safe to rerun: sections that already have questions are skipped,
 * and the linking call runs only while the item has no linking questions.
 */
export async function generateForItem(itemId: string) {
	const [item] = await db.select().from(t.contentItems).where(eq(t.contentItems.id, itemId))
	if (!item) return
	const [key] = await db.select().from(t.llmKeys).where(eq(t.llmKeys.userId, item.userId))
	if (!key) {
		await db.update(t.contentItems).set({ status: 'needs_key', error: null }).where(eq(t.contentItems.id, itemId))
		return
	}
	await db.update(t.contentItems).set({ status: 'processing', error: null }).where(eq(t.contentItems.id, itemId))

	const all = await db.select().from(t.sections).where(eq(t.sections.itemId, itemId)).orderBy(asc(t.sections.position))
	const done = new Set(
		(await db.selectDistinct({ id: t.questions.sectionId }).from(t.questions).where(eq(t.questions.itemId, itemId))).map((r) => r.id),
	)
	const inputs = all.map((s) => ({ title: s.title, level: s.level, wordCount: s.wordCount, text: sectionText(s) }))
	// Each section's key ideas, in order, with their row ids, so questions can point at them.
	const ideas: { id: string; text: string }[][] = all.map(() => [])
	for (const row of await db.select().from(t.ideas).where(eq(t.ideas.itemId, itemId)).orderBy(asc(t.ideas.position))) {
		ideas[all.findIndex((s) => s.id === row.sectionId)]?.push({ id: row.id, text: row.text })
	}
	const prefs = { intensity: item.questionIntensity, style: item.questionStyle }
	const apiKey = decryptSecret(key.encryptedKey)
	const provider = providers[key.provider]

	const store = async (qs: GeneratedQuestion[]) => {
		if (!qs.length) return
		await db.insert(t.questions).values(
			qs.map((q) => ({
				userId: item.userId,
				itemId,
				sectionId: all[q.section]!.id,
				alsoSectionIds: q.alsoSections.length ? q.alsoSections.map((i) => all[i]!.id) : null,
				ideaId: q.idea === null ? null : (ideas[q.section]?.[q.idea]?.id ?? null),
				type: q.type,
				level: q.level,
				content: q.content,
				promptVersion: GENERATE_QUESTIONS_PROMPT_VERSION,
			})),
		)
	}

	try {
		const pending = all.flatMap((s, i) => (done.has(s.id) || s.wordCount === 0 || (item.questionsOnDemand && !s.questionsWanted) ? [] : [i]))
		// Batches are planned over the pending sections only, in reading order.
		const batches = planBatches(pending.map((i) => inputs[i]!), prefs.intensity).map((b) => b.map((k) => pending[k]!))
		for (const batch of batches) {
			const out = await writeQuestions(provider, apiKey, key.model, inputs, batch, prefs)
			await db.transaction(async (tx) => {
				for (const [i, list] of out.ideas) {
					await tx.delete(t.ideas).where(eq(t.ideas.sectionId, all[i]!.id))
					ideas[i] = list.length
						? await tx
								.insert(t.ideas)
								.values(list.map((text, position) => ({ itemId, sectionId: all[i]!.id, position, text })))
								.returning({ id: t.ideas.id, text: t.ideas.text })
						: []
				}
			})
			await store(out.questions)
		}

		const [linked] = await db
			.select({ id: t.questions.id })
			.from(t.questions)
			.where(and(eq(t.questions.itemId, itemId), isNotNull(t.questions.alsoSectionIds)))
			.limit(1)
		// Books are written a chapter at a time, so links across the whole book are not; links within
		// a chapter come with its questions.
		if (!linked && !item.questionsOnDemand && planBatches(inputs, prefs.intensity).length > 1)
			await store(await linkSections(provider, apiKey, key.model, all.map((s, i) => ({ title: s.title, ideas: ideas[i]!.map((x) => x.text) })), prefs))

		await db.update(t.contentItems).set({ status: 'ready' }).where(eq(t.contentItems.id, itemId))
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		await db.update(t.contentItems).set({ status: 'failed', error: message }).where(eq(t.contentItems.id, itemId))
		throw err
	}
}

/** Replaces an item's questions with new ones written under the current rules. Their review history goes too. */
export async function rewriteQuestions(itemId: string) {
	await db.transaction(async (tx) => {
		await tx.delete(t.questions).where(eq(t.questions.itemId, itemId))
		await tx.delete(t.ideas).where(eq(t.ideas.itemId, itemId))
		await tx.update(t.contentItems).set({ status: 'processing', error: null }).where(eq(t.contentItems.id, itemId))
	})
	await enqueueGeneration(itemId)
}

/** After a key is added or changed, retry items that were waiting for one or had failed. */
export async function requeueWaitingItems(userId: string) {
	const items = await db
		.select({ id: t.contentItems.id })
		.from(t.contentItems)
		.where(and(eq(t.contentItems.userId, userId), inArray(t.contentItems.status, ['needs_key', 'failed'])))
	await Promise.all(items.map((i) => enqueueGeneration(i.id)))
}
