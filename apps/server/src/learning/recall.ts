import { isQuestionType, levelIndex, orderForTest, type PointStatus, type QuestionType, type RecallStatus } from '@life-log-club/domain'
import { gradeRecallRequest, parseRecallVerdict } from '@life-log-club/llm'
import { and, asc, eq, gt, inArray, isNull, sql } from 'drizzle-orm'
import { decrypt, encrypt } from '../crypto'
import { asUser, type Tx } from '../db/client'
import { cards, questions, type RecallItem, readings, recallAttempts, reviewLog, sections } from '../db/schema'
import { callAi } from './ai'

export type GradeJob = { userId: string; attemptId: string }

const textContext = (attemptId: string) => `recall_attempts.text:${attemptId}`
export const sealDump = (attemptId: string, text: string) => encrypt(text, textContext(attemptId))
const openDump = (attemptId: string, textCt: string | null) => (textCt === null ? null : decrypt(textCt, textContext(attemptId)))

const NO_IDEAS = 'No key ideas could be found in this section, so your recall can’t be checked. Try again later.'
export const GRADE_FAILED = 'Checking your recall failed. Try again in a few minutes.'

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
 * Picks what to ask on each key idea after the dump, and sets the level a card not started yet
 * starts at. A missed idea is asked its cue; a vague one its lowest stored question; a covered one
 * its highest, so it is asked something harder than the dump already gave. Missed ideas first.
 * The cards start from their first answer.
 */
async function prepareItems(tx: Tx, marks: { cardId: string; status: PointStatus }[]): Promise<RecallItem[]> {
	const ids = marks.map((m) => m.cardId)
	const rows = await tx.select().from(cards).where(inArray(cards.id, ids)).for('update')
	const stored = await tx
		.select({ id: questions.id, cardId: questions.cardId, type: questions.type, level: questions.level })
		.from(questions)
		.where(and(inArray(questions.cardId, ids), isNull(questions.retiredAt)))
	const items: (RecallItem & { type: QuestionType | null })[] = []
	for (const { cardId, status } of marks) {
		const card = rows.find((c) => c.id === cardId)
		if (!card) continue
		const own = stored.filter((q) => q.cardId === cardId).sort((a, b) => levelIndex(a.level) - levelIndex(b.level))
		const question = status === 'missing' ? undefined : status === 'vague' ? own[0] : own.at(-1)
		if (!card.startedAt) await tx.update(cards).set({ level: startLevel(status, own.length ? levelIndex(own.at(-1)!.level) : undefined) }).where(eq(cards.id, cardId))
		items.push({ cardId, questionId: question?.id ?? null, type: question && isQuestionType(question.type) ? question.type : null })
	}
	return orderForTest(items, new Map(marks.map((m) => [m.cardId, m.status]))).map(({ cardId, questionId }) => ({ cardId, questionId }))
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

	await asUser(userId, async (tx) => {
		// A second job for the same attempt finds it graded and changes nothing.
		const [current] = await tx.select({ status: recallAttempts.status }).from(recallAttempts).where(eq(recallAttempts.id, attemptId)).for('update')
		if (current?.status !== 'grading') return
		const results = ideas.map((c, i) => ({ cardId: c.id, status: marks[i]! }))
		const items = await prepareItems(tx, results)
		await tx.update(recallAttempts).set({ status: 'graded', results, items, feedback: feedback || null, gradedBy }).where(eq(recallAttempts.id, attemptId))
		await tx
			.update(sections)
			.set({ recalledAt: sql`coalesce(${sections.recalledAt}, now())` })
			.where(inArray(sections.id, attempt.sectionIds))
	})
}

const promptOf = (content: Record<string, unknown>) => ({
	prompt: typeof content.prompt === 'string' ? content.prompt : '',
	code: typeof content.code === 'string' ? content.code : null,
})

/**
 * An attempt as the member sees it. Once graded: the questions to ask, then, once every one is
 * answered, the results and the retry round. Nothing of the results shows before the last answer.
 */
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
	const base = {
		id: attempt.id,
		readingId: attempt.readingId,
		readingTitle: row.readingTitle,
		sections: shown.map(({ id, title }) => ({ id, title })),
		status: attempt.status,
		text: openDump(attempt.id, attempt.textCt),
		feedback: attempt.feedback,
		nextSectionId: next?.id ?? null,
		items: null,
		ideas: null,
		retry: null,
	}
	if (attempt.status !== 'graded' || !attempt.results) return base

	const ids = attempt.results.map((r) => r.cardId)
	const rows = ids.length ? await tx.select().from(cards).where(inArray(cards.id, ids)) : []
	const asked = attempt.items ?? []
	const qIds = asked.flatMap((i) => (i.questionId ? [i.questionId] : []))
	const qs = qIds.length ? await tx.select().from(questions).where(inArray(questions.id, qIds)) : []
	const log = await tx.select().from(reviewLog).where(eq(reviewLog.attemptId, attempt.id)).orderBy(asc(reviewLog.reviewedAt))
	const answerOf = (cardId: string, mode: 'recall' | 'practice') => log.find((l) => l.cardId === cardId && l.mode === mode)
	const ask = (cardId: string, questionId: string | null, mode: 'recall' | 'practice') => {
		const q = questionId ? qs.find((x) => x.id === questionId) : undefined
		const card = rows.find((c) => c.id === cardId)
		const { prompt, code } = q ? promptOf(q.content) : { prompt: card?.prompt ?? '', code: null }
		return { cardId, questionId: q ? questionId : null, prompt, code, answered: Boolean(answerOf(cardId, mode)) }
	}
	const items = asked.map((i) => ask(i.cardId, i.questionId, 'recall'))
	if (items.some((i) => !i.answered)) return { ...base, items }

	const ideas = attempt.results.flatMap((r) => {
		const card = rows.find((c) => c.id === r.cardId)
		if (!card) return []
		const log = answerOf(card.id, 'recall')
		const item = items.find((i) => i.cardId === card.id)
		const given = log?.response && typeof log.response.answer === 'string' ? log.response.answer : null
		const answer =
			log?.answerId && item
				? {
						answerId: log.answerId,
						prompt: item.prompt,
						given,
						correct: log.correct ?? false,
						confidence: log.confidence,
						overridden: log.overriddenAt !== null,
						reveal: log.reveal ?? { reference: card.answer, feedback: '', points: [], misconception: null, quote: card.quote },
					}
				: null
		return [{ cardId: card.id, idea: card.answer, quote: card.quote, status: r.status, dueAt: card.dueAt, answer }]
	})
	// Retry missed ideas asks each one through its cue again; its written questions stay unasked for Review.
	const retry = ideas.filter((i) => i.answer && !i.answer.correct).map((i) => ask(i.cardId, null, 'practice'))
	return { ...base, items, ideas, retry }
}
