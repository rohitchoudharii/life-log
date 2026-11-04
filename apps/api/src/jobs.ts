import { sectionText } from '@peak/core'
import { GENERATE_QUESTIONS_PROMPT_VERSION, linkSections, planBatches, providers, writeQuestions, type GeneratedQuestion } from '@peak/llm'
import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm'
import { PgBoss } from 'pg-boss'
import { decryptSecret } from './crypto'
import { db, t } from './db'
import { env } from './env'

const QUEUE = 'generate-questions'
const boss = new PgBoss(env.DATABASE_URL)

export async function startJobs() {
	boss.on('error', (err) => console.error('[jobs]', err))
	await boss.start()
	await boss.createQueue(QUEUE, { retryLimit: 2, retryDelay: 30, retryBackoff: true })
	await boss.work<{ itemId: string }>(QUEUE, async ([job]) => {
		if (job) await generateForItem(job.data.itemId)
	})
}

export const enqueueGeneration = (itemId: string) =>
	boss.send(QUEUE, { itemId }, { singletonKey: itemId })

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
		const pending = all.flatMap((s, i) => (done.has(s.id) || s.wordCount === 0 ? [] : [i]))
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
		if (!linked && planBatches(inputs, prefs.intensity).length > 1)
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
