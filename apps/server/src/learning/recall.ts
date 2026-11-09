import { answerIdea, defaultScheduler, levelIndex, type PointStatus, type Rating, type RecallStatus } from '@life-log-club/domain'
import { gradeRecallRequest, parseRecallVerdict } from '@life-log-club/llm'
import { and, asc, eq, gt, inArray, isNull, sql } from 'drizzle-orm'
import { decrypt, encrypt } from '../crypto'
import { asUser, type Tx } from '../db/client'
import { cards, questions, readings, recallAttempts, reviewLog, sections } from '../db/schema'
import { callAi } from './ai'

export type GradeJob = { userId: string; attemptId: string }

const textContext = (attemptId: string) => `recall_attempts.text:${attemptId}`
export const sealDump = (attemptId: string, text: string) => encrypt(text, textContext(attemptId))
const openDump = (attemptId: string, textCt: string | null) => (textCt === null ? null : decrypt(textCt, textContext(attemptId)))

const NO_IDEAS = 'No key ideas could be found in this section, so your recall can’t be checked. Try again later.'
export const GRADE_FAILED = 'Checking your recall failed. Try again in a few minutes.'

/** A dump mark as a first rating: covered is right, vague is hard, missed is forgotten. */
const RATING: Record<PointStatus, Rating> = { covered: 'good', vague: 'hard', missing: 'again' }

/**
 * The level a card starts at from its dump mark: a missed idea at recall (its cue), a vague one
 * at explain, and a covered one at its highest question, so it is asked something harder than
 * the dump already gave.
 */
const startLevel = (status: PointStatus, highest: number | undefined) => (status === 'missing' ? 0 : status === 'vague' ? 1 : Math.max(1, highest ?? 1))

/** The key ideas of the sections, in reading order. */
async function ideasOf(tx: Tx, sectionIds: string[]) {
	return tx
		.select({ card: cards })
		.from(cards)
		.innerJoin(sections, eq(sections.id, cards.sectionId))
		.where(and(inArray(cards.sectionId, sectionIds), eq(cards.origin, 'ai'), isNull(cards.deletedAt)))
		.orderBy(asc(sections.position), asc(cards.position))
		.then((rows) => rows.map((r) => r.card))
}

/**
 * Applies the marks: each card's schedule moves as one answer from the dump. A card not started
 * yet starts now, at the level its mark sets, so a covered idea is back in a day and a missed one
 * in 10 minutes.
 */
async function applyMarks(tx: Tx, userId: string, marks: { cardId: string; status: PointStatus }[], gradedBy: 'ai' | 'code', now: Date) {
	const ids = marks.map((m) => m.cardId)
	const rows = await tx.select().from(cards).where(inArray(cards.id, ids)).for('update')
	const levels = await tx
		.select({ cardId: questions.cardId, level: questions.level })
		.from(questions)
		.where(and(inArray(questions.cardId, ids), isNull(questions.retiredAt)))
	for (const { cardId, status } of marks) {
		const card = rows.find((c) => c.id === cardId)
		if (!card) continue
		const grade = { correct: status === 'covered', rating: RATING[status] }
		const next = answerIdea({ state: card.state, level: card.level, dueAt: card.dueAt }, grade, now, defaultScheduler)
		const highest = levels.filter((q) => q.cardId === cardId).map((q) => levelIndex(q.level))
		const level = card.startedAt ? next.level : startLevel(status, highest.length ? Math.max(...highest) : undefined)
		await tx
			.update(cards)
			.set({ state: next.state, dueAt: next.dueAt, level, startedAt: card.startedAt ?? now })
			.where(eq(cards.id, cardId))
		await tx.insert(reviewLog).values({
			userId,
			cardId,
			ask: 'self',
			mode: 'recall',
			rating: grade.rating,
			correct: grade.correct,
			response: { dump: status },
			gradedBy,
			reviewedAt: now,
			nextDueAt: next.dueAt,
		})
	}
}

/**
 * The `grade-recall` job: checks a brain dump against the key ideas of its sections. It waits
 * while any of them is still being written, and the write job queues it again when it ends. An
 * empty dump marks every idea missed without an AI call. Without a key the attempt is left for
 * the member to check (`self`). A reply that can't be read is retried, and on the last try the
 * attempt is `failed`.
 */
export async function gradeAttempt({ userId, attemptId }: GradeJob, lastTry = true) {
	const ready = await asUser(userId, async (tx) => {
		const [attempt] = await tx.select().from(recallAttempts).where(eq(recallAttempts.id, attemptId))
		if (!attempt || (attempt.status !== 'waiting' && attempt.status !== 'grading')) return null
		const statuses = await tx.select({ writeStatus: sections.writeStatus }).from(sections).where(inArray(sections.id, attempt.sectionIds))
		const set = (status: RecallStatus, feedback: string | null = null) =>
			tx.update(recallAttempts).set({ status, feedback }).where(eq(recallAttempts.id, attemptId)).then(() => null)
		if (statuses.some((s) => s.writeStatus === 'none' || s.writeStatus === 'queued' || s.writeStatus === 'writing')) return set('waiting')
		const ideas = await ideasOf(tx, attempt.sectionIds)
		if (!ideas.length) return statuses.some((s) => s.writeStatus === 'needs_key') ? set('self') : set('failed', NO_IDEAS)
		await set('grading')
		return { attempt, ideas, text: openDump(attemptId, attempt.textCt) ?? '' }
	})
	if (!ready) return
	const { attempt, ideas, text } = ready

	let marks: PointStatus[]
	let feedback = ''
	let gradedBy: 'ai' | 'code' = 'code'
	if (!text) marks = ideas.map(() => 'missing')
	else {
		try {
			const reply = await callAi(userId, 'grade-recall', (model) => gradeRecallRequest(model, { ideas: ideas.map((c) => c.answer), text }))
			if (reply === null) {
				await asUser(userId, (tx) => tx.update(recallAttempts).set({ status: 'self' }).where(eq(recallAttempts.id, attemptId)))
				return
			}
			const verdict = parseRecallVerdict(reply, ideas.length)
			if (!verdict) throw new Error('The model did not grade the ideas')
			marks = verdict.ideas
			feedback = verdict.feedback
			gradedBy = 'ai'
		} catch (error) {
			if (!lastTry) throw error
			console.warn('[grade-recall]', error instanceof Error ? error.message : error)
			await asUser(userId, (tx) => tx.update(recallAttempts).set({ status: 'failed', feedback: GRADE_FAILED }).where(eq(recallAttempts.id, attemptId)))
			return
		}
	}

	const now = new Date()
	await asUser(userId, async (tx) => {
		// A second job for the same attempt finds it graded and changes nothing.
		const [current] = await tx.select({ status: recallAttempts.status }).from(recallAttempts).where(eq(recallAttempts.id, attemptId)).for('update')
		if (current?.status !== 'grading') return
		const results = ideas.map((c, i) => ({ cardId: c.id, status: marks[i]! }))
		await applyMarks(tx, userId, results, gradedBy, now)
		await tx.update(recallAttempts).set({ status: 'graded', results, feedback: feedback || null, gradedBy }).where(eq(recallAttempts.id, attemptId))
		await tx
			.update(sections)
			.set({ recalledAt: sql`coalesce(${sections.recalledAt}, now())` })
			.where(inArray(sections.id, attempt.sectionIds))
	})
}

/** An attempt as the member sees it: the recall map only once it is graded. */
export async function attemptView(tx: Tx, attemptId: string) {
	const [row] = await tx
		.select({ attempt: recallAttempts, readingTitle: readings.title })
		.from(recallAttempts)
		.innerJoin(readings, eq(readings.id, recallAttempts.readingId))
		.where(eq(recallAttempts.id, attemptId))
	if (!row) return null
	const { attempt } = row
	const shown = await tx
		.select({ id: sections.id, title: sections.title, position: sections.position })
		.from(sections)
		.where(inArray(sections.id, attempt.sectionIds))
		.orderBy(asc(sections.position))
	const [next] = await tx
		.select({ id: sections.id })
		.from(sections)
		.where(and(eq(sections.readingId, attempt.readingId), gt(sections.position, shown.at(-1)?.position ?? -1)))
		.orderBy(asc(sections.position))
		.limit(1)
	let ideas = null
	if (attempt.status === 'graded' && attempt.results) {
		const rows = await tx.select().from(cards).where(inArray(cards.id, attempt.results.map((r) => r.cardId)))
		ideas = attempt.results.flatMap((r) => {
			const card = rows.find((c) => c.id === r.cardId)
			return card ? [{ cardId: card.id, idea: card.answer, quote: card.quote, status: r.status, dueAt: card.dueAt }] : []
		})
	}
	return {
		id: attempt.id,
		readingId: attempt.readingId,
		readingTitle: row.readingTitle,
		sections: shown.map(({ id, title }) => ({ id, title })),
		status: attempt.status,
		text: openDump(attempt.id, attempt.textCt),
		feedback: attempt.feedback,
		ideas,
		nextSectionId: next?.id ?? null,
	}
}
