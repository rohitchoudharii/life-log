import { randomUUID } from 'node:crypto'
import { blockText, defaultScheduler, type WriteStatus } from '@life-log-club/domain'
import { type Complete, type SectionText, WRITE_SECTION_PROMPT_VERSION, type Written, writeQuestions, writeSection } from '@life-log-club/llm'
import { ORPCError } from '@orpc/server'
import { type AnyColumn, and, asc, eq, gt, inArray, isNull, type SQL, sql } from 'drizzle-orm'
import { asUser, type Tx } from '../db/client'
import { aiKeys, cards, questions, readings, reviewLog, sections } from '../db/schema'
import { callAi, withinBudget } from './ai'
import { preferencesOf } from './preferences'

/** A section shorter than this is written together with the next one; each keeps the ideas it quotes. */
export const MERGE_UNDER_WORDS = 80

/** A chapter recalled whole is written in batches of sections up to about this many words, one call each. */
export const CHAPTER_BATCH_WORDS = 4000

/**
 * `recall`: the member pressed Recall on the section and is waiting, so the budget doesn't stop
 * it. `with`: more sections of the same chapter to write in the same call (Recall chapter).
 * `rewrite`: new questions for the key ideas it has (Rewrite questions).
 */
export type WriteJob = { userId: string; sectionId: string; recall?: boolean; with?: string[]; rewrite?: boolean }

/**
 * Splits a chapter's sections, in reading order, into batches of up to CHAPTER_BATCH_WORDS each.
 * A section longer than that is a batch of its own.
 */
export function chapterBatches<S extends { wordCount: number }>(list: S[]): S[][] {
	const batches: S[][] = []
	let words = Number.POSITIVE_INFINITY
	for (const s of list) {
		if (words + s.wordCount > CHAPTER_BATCH_WORDS) {
			batches.push([])
			words = 0
		}
		batches.at(-1)!.push(s)
		words += s.wordCount
	}
	return batches
}

export const WRITE_FAILED = 'Writing questions for this section failed. Try again in a few minutes.'
const NO_IDEAS = 'No key ideas could be found in this section. Try again, or save ideas yourself.'

class NoKey extends Error {}

const setStatus = (tx: Tx, ids: string[], writeStatus: WriteStatus, writeError: string | null = null) =>
	Promise.all(ids.map((id) => tx.update(sections).set({ writeStatus, writeError }).where(eq(sections.id, id))))

const hasIdeas = async (tx: Tx, sectionId: string) =>
	(await tx.select({ id: cards.id }).from(cards).where(and(eq(cards.sectionId, sectionId), eq(cards.origin, 'ai'))).limit(1)).length > 0

type Row = typeof sections.$inferSelect
const toText = (s: Row): SectionText => ({ title: s.title, text: s.blocks.map(blockText).filter(Boolean).join('\n\n'), wordCount: s.wordCount })

const writable = (s: Row) => s.kind === 'body' && s.wordCount > 0

/**
 * The sections to write together: this one and `more` (a chapter batch) when given, else this one
 * and the next when this one is under MERGE_UNDER_WORDS. Sections with ideas already are marked
 * ready and left out. Null when there is nothing to write: a reference section, one with no
 * words, or one whose ideas exist already.
 */
async function batchFor(tx: Tx, sectionId: string, more: string[] = []): Promise<Row[] | null> {
	const [section] = await tx.select().from(sections).where(eq(sections.id, sectionId)).for('update')
	if (!section || !writable(section)) return null
	if (more.length) {
		const rows = await tx
			.select()
			.from(sections)
			.where(and(eq(sections.readingId, section.readingId), inArray(sections.id, [sectionId, ...more])))
			.orderBy(asc(sections.position))
			.for('update')
		const batch: Row[] = []
		for (const row of rows.filter(writable)) {
			if (await hasIdeas(tx, row.id)) await setStatus(tx, [row.id], 'ready')
			else batch.push(row)
		}
		return batch.length ? batch : null
	}
	if (await hasIdeas(tx, sectionId)) {
		await setStatus(tx, [sectionId], 'ready')
		return null
	}
	if (section.wordCount >= MERGE_UNDER_WORDS) return [section]
	const [next] = await tx
		.select()
		.from(sections)
		.where(and(eq(sections.readingId, section.readingId), gt(sections.position, section.position), eq(sections.kind, 'body'), gt(sections.wordCount, 0)))
		.orderBy(asc(sections.position))
		.limit(1)
	return next && !(await hasIdeas(tx, next.id)) ? [section, next] : [section]
}

/**
 * Stores what was written, one card per key idea with its questions. Each section is locked and
 * gets ideas only when it has none from the AI yet, so a second job for the same section (the
 * ideas race) adds nothing. No job ever deletes cards.
 */
async function store(userId: string, batch: Row[], written: Written) {
	await asUser(userId, async (tx) => {
		for (const [n, section] of batch.entries()) {
			await tx.select({ id: sections.id }).from(sections).where(eq(sections.id, section.id)).for('update')
			if (!(await hasIdeas(tx, section.id))) {
				const ideas = written.ideas.filter((i) => i.section === n)
				for (const [position, idea] of ideas.entries()) {
					const id = randomUUID()
					await tx.insert(cards).values({
						id,
						userId,
						kind: 'idea',
						origin: 'ai',
						readingId: section.readingId,
						sectionId: section.id,
						position,
						prompt: idea.cue,
						answer: idea.idea,
						quote: idea.quote,
						state: defaultScheduler.initial(),
					})
					if (idea.questions.length)
						await tx.insert(questions).values(
							idea.questions.map((q) => ({
								userId,
								cardId: id,
								readingId: section.readingId,
								sectionId: section.id,
								type: q.type,
								level: q.level,
								content: q.content as Record<string, unknown>,
								promptVersion: WRITE_SECTION_PROMPT_VERSION,
							})),
						)
				}
			}
			const spareIdeas = written.spare.filter((i) => i.section === n).map(({ idea, cue, quote }) => ({ idea, cue, quote }))
			await tx
				.update(sections)
				.set({ writeStatus: 'ready', writeError: null, promptVersion: WRITE_SECTION_PROMPT_VERSION, spareIdeas })
				.where(eq(sections.id, section.id))
		}
	})
}

/**
 * The `write-section` job: writes a section's key ideas, each with a cue and a quote from the
 * text, and questions at the member's amount. Without a key the section waits as `needs_key`;
 * past this month's budget it waits as `paused`, unless the member pressed Recall on it. A reply
 * with no valid idea is tried once more. A provider error is thrown so the job is retried, and on
 * the last try the section is marked `failed`. Returns where the section ends up.
 */
export async function writeKeyIdeas(job: WriteJob, lastTry = true): Promise<WriteStatus> {
	if (job.rewrite) return rewriteQuestions(job, lastTry)
	const { userId, sectionId } = job
	const batch = await asUser(userId, async (tx) => {
		const rows = await batchFor(tx, sectionId, job.with)
		if (!rows) return null
		const [key] = await tx.select({ userId: aiKeys.userId }).from(aiKeys)
		if (!key) {
			// A chapter's sections all stop waiting, so its recall check can go on without them.
			await setStatus(tx, job.with ? rows.map((s) => s.id) : [sectionId], 'needs_key')
			return 'needs_key' as const
		}
		return rows
	})
	if (batch === null) return 'ready'
	if (batch === 'needs_key') return batch
	const ids = batch.map((s) => s.id)
	if (!job.recall && !(await withinBudget(userId))) {
		await asUser(userId, (tx) => setStatus(tx, [sectionId], 'paused'))
		return 'paused'
	}
	const prefs = await asUser(userId, (tx) => preferencesOf(tx, userId))
	await asUser(userId, (tx) => setStatus(tx, ids, 'writing'))

	const complete: Complete = async (purpose, request) => {
		const reply = await callAi(userId, purpose, request)
		if (reply === null) throw new NoKey()
		return reply
	}
	try {
		let written: Written | null = null
		for (let attempt = 0; attempt < 2 && !written?.ideas.length; attempt++)
			written = await writeSection(complete, batch.map(toText), { amount: prefs.questionAmount, style: prefs.questionStyle, qualityCheck: prefs.qualityCheck })
		if (!written?.ideas.length) {
			await asUser(userId, (tx) => setStatus(tx, ids, 'failed', NO_IDEAS))
			return 'failed'
		}
		await store(userId, batch, written)
		return 'ready'
	} catch (error) {
		// The key was removed while the job ran.
		if (error instanceof NoKey) {
			await asUser(userId, (tx) => setStatus(tx, ids, 'needs_key'))
			return 'needs_key'
		}
		if (!lastTry) throw error
		console.warn('[write-section]', error instanceof Error ? error.message : error)
		await asUser(userId, (tx) => setStatus(tx, ids, 'failed', WRITE_FAILED))
		return 'failed'
	}
}

/** Whether any key idea of the section has started or has an answer, so it can't be written again. */
export const ideasInUse = (sectionId: SQL | AnyColumn | string) => sql<boolean>`exists (
	select 1 from ${cards} where ${cards.sectionId} = ${sectionId} and ${cards.origin} = 'ai'
	and (${cards.startedAt} is not null or exists (select 1 from ${reviewLog} where ${reviewLog.cardId} = ${cards.id}))
)`

/**
 * Rewrite questions, asked by the member: retires the section's questions and marks it `queued`
 * for the job that writes new ones. Answers point at the questions they answered, so retired
 * questions stay and every answer and schedule is kept. With `ideas`, on a section none of
 * whose key ideas is in use, the key ideas are deleted to be written again. Returns the job to
 * queue.
 */
export async function startRewrite(tx: Tx, userId: string, sectionId: string, ideas: boolean): Promise<WriteJob> {
	const [section] = await tx
		.select({ id: sections.id, kind: sections.kind, wordCount: sections.wordCount, writeStatus: sections.writeStatus, inUse: ideasInUse(sections.id) })
		.from(sections)
		.innerJoin(readings, eq(readings.id, sections.readingId))
		.where(and(eq(sections.id, sectionId), isNull(readings.deletedAt)))
		.for('update', { of: sections })
	if (!section) throw new ORPCError('NOT_FOUND', { message: 'That section does not exist. It may have been removed.' })
	if (section.kind !== 'body' || section.wordCount === 0) throw new ORPCError('BAD_REQUEST', { message: 'This section has no questions to rewrite.' })
	if (!(await tx.select({ id: aiKeys.userId }).from(aiKeys)).length)
		throw new ORPCError('BAD_REQUEST', { message: 'Add your own AI key in Settings to rewrite questions.' })
	if (section.writeStatus === 'queued' || section.writeStatus === 'writing')
		throw new ORPCError('CONFLICT', { message: 'Questions for this section are being written now. Try again when they are ready.' })
	if (ideas) {
		if (section.inUse) throw new ORPCError('CONFLICT', { message: 'Some of these key ideas are in review already, so only their questions can be rewritten.' })
		// Nothing points at these cards yet: none has started or been answered. Their questions go with them.
		await tx.delete(cards).where(and(eq(cards.sectionId, sectionId), eq(cards.origin, 'ai')))
		await tx.update(sections).set({ writeStatus: 'queued', writeError: null, spareIdeas: [] }).where(eq(sections.id, sectionId))
		return { userId, sectionId, recall: true }
	}
	const { questionAmount } = await preferencesOf(tx, userId)
	if (questionAmount === 'quick')
		throw new ORPCError('BAD_REQUEST', { message: 'Your questions are set to Quick, so key ideas are asked through their cues only. Choose Standard or Thorough in Settings → Questions first.' })
	await tx
		.update(questions)
		.set({ retiredAt: new Date() })
		.where(and(eq(questions.sectionId, sectionId), isNull(questions.retiredAt)))
	await tx.update(sections).set({ writeStatus: 'queued', writeError: null }).where(eq(sections.id, sectionId))
	return { userId, sectionId, rewrite: true }
}

/**
 * The job behind Rewrite questions: fresh questions at the member's amount and kinds for the
 * section's key ideas, unlike any asked before. The member asked for it, so the budget doesn't
 * stop it. When it fails, the key ideas are asked through their cues until it is tried again.
 */
async function rewriteQuestions({ userId, sectionId }: WriteJob, lastTry: boolean): Promise<WriteStatus> {
	const loaded = await asUser(userId, async (tx) => {
		const [section] = await tx.select().from(sections).where(eq(sections.id, sectionId))
		if (!section) return null
		const ideas = await tx
			.select()
			.from(cards)
			.where(and(eq(cards.sectionId, sectionId), eq(cards.origin, 'ai'), isNull(cards.deletedAt)))
			.orderBy(asc(cards.position))
		const asked = ideas.length ? await tx.select({ cardId: questions.cardId, content: questions.content }).from(questions).where(inArray(questions.cardId, ideas.map((c) => c.id))) : []
		return { section, ideas, asked, prefs: await preferencesOf(tx, userId) }
	})
	if (!loaded) return 'ready'
	const { section, ideas, asked, prefs } = loaded
	if (!ideas.length) {
		await asUser(userId, (tx) => setStatus(tx, [sectionId], 'ready'))
		return 'ready'
	}
	await asUser(userId, (tx) => setStatus(tx, [sectionId], 'writing'))
	const complete: Complete = async (purpose, request) => {
		const reply = await callAi(userId, purpose, request)
		if (reply === null) throw new NoKey()
		return reply
	}
	try {
		const asks = ideas.map((c) => ({
			idea: c.answer,
			cue: c.prompt,
			quote: c.quote ?? '',
			asked: asked.filter((q) => q.cardId === c.id).map((q) => String(q.content.prompt ?? '')),
		}))
		const written = await writeQuestions(complete, toText(section), asks, { amount: prefs.questionAmount, style: prefs.questionStyle, qualityCheck: prefs.qualityCheck })
		await asUser(userId, async (tx) => {
			const rows = ideas.flatMap((card, i) =>
				(written.questions[i] ?? []).map((q) => ({
					userId,
					cardId: card.id,
					readingId: section.readingId,
					sectionId,
					type: q.type,
					level: q.level,
					content: q.content as Record<string, unknown>,
					promptVersion: WRITE_SECTION_PROMPT_VERSION,
				})),
			)
			if (rows.length) await tx.insert(questions).values(rows)
			await setStatus(tx, [sectionId], 'ready')
		})
		return 'ready'
	} catch (error) {
		if (error instanceof NoKey) {
			await asUser(userId, (tx) => setStatus(tx, [sectionId], 'needs_key'))
			return 'needs_key'
		}
		if (!lastTry) throw error
		console.warn('[rewrite-questions]', error instanceof Error ? error.message : error)
		await asUser(userId, (tx) => setStatus(tx, [sectionId], 'failed', WRITE_FAILED))
		return 'failed'
	}
}
