import { sectionText } from '@life-log-club/core'
import { GENERATE_QUESTIONS_PROMPT_VERSION, linkSections, planBatches, providers, writeQuestions, type GeneratedQuestion } from '@life-log-club/llm'
import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm'
import { PgBoss, type JobWithMetadata } from 'pg-boss'
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
	await boss.work(QUEUE, { localConcurrency: 3, includeMetadata: true }, async ([job]: JobWithMetadata<{ itemId: string }>[]) => {
		if (job) await generateForItem(job.data.itemId, job.retryCount >= job.retryLimit)
	})
	// Items left mid-way by a restart or by the old queue (whose 15-minute limit cut long items short).
	if (await boss.getQueue(OLD_QUEUE)) await boss.deleteQueue(OLD_QUEUE)
	const stuck = await db.select({ id: t.contentItems.id }).from(t.contentItems).where(eq(t.contentItems.status, 'processing'))
	await Promise.all(stuck.map((i) => enqueueGeneration(i.id)))
}

export const enqueueGeneration = (itemId: string) => boss.send(QUEUE, { itemId }, { singletonKey: itemId })

/** Imports every page a reading links to. The web routes own importing a page, so they register the worker. */
const LINKS_QUEUE = 'import-links'
export const enqueueLinkImport = (itemId: string) => boss.send(LINKS_QUEUE, { itemId }, { singletonKey: itemId })

export async function workLinkImports(handler: (itemId: string) => Promise<void>) {
	const options = { retryLimit: 1, retryDelay: 30, expireInSeconds: 60 * 60, heartbeatSeconds: 30 }
	if (!(await boss.getQueue(LINKS_QUEUE))) await boss.createQueue(LINKS_QUEUE, { policy: 'stately', ...options })
	await boss.work<{ itemId: string }>(LINKS_QUEUE, { localConcurrency: 2 }, async ([job]) => {
		if (job) await handler(job.data.itemId)
	})
	// Imports cut short by a restart pick up where they were: pages already imported are skipped.
	const stuck = await db.select({ id: t.contentItems.id }).from(t.contentItems).where(eq(t.contentItems.linksImport, 'importing'))
	await Promise.all(stuck.map((i) => enqueueLinkImport(i.id)))
}

/**
 * Writes questions for the sections picked in Manage test, and nothing else: the AI is only ever
 * called because the learner asked. Sections are sent in batches of whole chapters; when the whole
 * reading is written and it takes more than one batch, a last call writes questions that link
 * sections across batches. Safe to rerun: sections that already have questions are skipped, and
 * the linking call runs only while the item has no linking questions. A failure shows as failed
 * only on the last try; until then the item stays processing while the job retries.
 */
export async function generateForItem(itemId: string, lastTry: boolean) {
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
	const [owner] = await db
		.select({ qualityCheck: t.users.qualityCheck, intensity: t.users.questionIntensity, style: t.users.questionStyle })
		.from(t.users)
		.where(eq(t.users.id, item.userId))
	const prefs = { intensity: item.questionIntensity ?? owner!.intensity, style: item.questionStyle ?? owner!.style, qualityCheck: owner!.qualityCheck }
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
		const pending = all.flatMap((s, i) => (done.has(s.id) || s.wordCount === 0 || !s.questionsWanted ? [] : [i]))
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
			const terms = [...out.terms.values()].flat()
			// A word already in the vocabulary keeps its first sentence and its schedule.
			if (terms.length) await db.insert(t.words).values(terms.map((w) => ({ userId: item.userId, itemId, ...w }))).onConflictDoNothing()
		}

		const [linked] = await db
			.select({ id: t.questions.id })
			.from(t.questions)
			.where(and(eq(t.questions.itemId, itemId), isNotNull(t.questions.alsoSectionIds)))
			.limit(1)
		// Links across the whole reading are written only when all of it was; links within a batch
		// come with its questions.
		if (!linked && pending.length === all.filter((s) => s.wordCount > 0).length && batches.length > 1)
			await store(await linkSections(provider, apiKey, key.model, all.map((s, i) => ({ title: s.title, ideas: ideas[i]!.map((x) => x.text) })), prefs))

		await db.update(t.contentItems).set({ status: 'ready' }).where(eq(t.contentItems.id, itemId))
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		if (lastTry) await db.update(t.contentItems).set({ status: 'failed', error: message }).where(eq(t.contentItems.id, itemId))
		throw err
	}
}

/** After a key is added or changed, retry items that were waiting for one or had failed. */
export async function requeueWaitingItems(userId: string) {
	const items = await db
		.select({ id: t.contentItems.id })
		.from(t.contentItems)
		.where(and(eq(t.contentItems.userId, userId), inArray(t.contentItems.status, ['needs_key', 'failed'])))
	await Promise.all(items.map((i) => enqueueGeneration(i.id)))
}
