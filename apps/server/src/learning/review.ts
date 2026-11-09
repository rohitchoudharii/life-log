import type { ReviewFilter, ReviewItem } from '@life-log-club/contract'
import { defaultScheduler, isQuestionType, pickQuestion, toPrompt } from '@life-log-club/domain'
import { and, desc, eq, inArray, isNotNull, isNull, lte, max, type SQL } from 'drizzle-orm'
import type { Tx } from '../db/client'
import { aiKeys, cards, questions, readings, reviewLog, sections } from '../db/schema'

/** Until a member has answered enough to measure, an answer is taken to need this long. */
const DEFAULT_ANSWER_SECONDS = 25
/** Gaps longer than this between two answers are a break, not an answer. */
const SESSION_GAP_SECONDS = 5 * 60

const FILTERS: Record<ReviewFilter, SQL | undefined> = {
	all: undefined,
	readings: isNotNull(cards.sectionId),
	lessons: eq(cards.kind, 'lesson'),
	words: eq(cards.kind, 'word'),
}

/** Cards due now that have started and are not removed, for one filter. */
export const dueNow = (filter: ReviewFilter = 'all') => and(lte(cards.dueAt, new Date()), isNotNull(cards.startedAt), isNull(cards.deletedAt), FILTERS[filter])

/**
 * About how many minutes `total` answers take this member: the median gap between answers given
 * one after another over their last 200, times the count. Gaps over 5 minutes are breaks.
 */
export async function minutesFor(tx: Tx, total: number) {
	if (!total) return 0
	const times = await tx.select({ at: reviewLog.reviewedAt }).from(reviewLog).orderBy(desc(reviewLog.reviewedAt)).limit(200)
	const gaps = times
		.slice(1)
		.map((t, i) => (times[i]!.at.getTime() - t.at.getTime()) / 1000)
		.filter((g) => g > 0 && g <= SESSION_GAP_SECONDS)
		.sort((a, b) => a - b)
	const seconds = gaps.length >= 5 ? gaps[Math.floor(gaps.length / 2)]! : DEFAULT_ANSWER_SECONDS
	return Math.max(1, Math.round((total * seconds) / 60))
}

/**
 * The next due cards, the one the member is most likely to have forgotten first: lowest
 * predicted recall now, with cards never answered (nothing to predict from) before the rest, and
 * oldest due first between equals. Each comes with the one thing to ask: a question not asked
 * yet, nearest the card's level (`pickQuestion`), else the cue. Written questions and cues are
 * judged with the member's AI key; without one, the card is self-rated.
 */
export async function nextBatch(tx: Tx, limit: number, filter: ReviewFilter) {
	const now = new Date()
	// Predicted recall comes from the FSRS forgetting curve, in code, so every due card is ranked here.
	const due = await tx.select({ id: cards.id, state: cards.state, dueAt: cards.dueAt }).from(cards).where(dueNow(filter))
	const recall = new Map(due.map((c) => [c.id, defaultScheduler.retrievability(c.state, now) ?? -1]))
	const ids = due
		.sort((a, b) => recall.get(a.id)! - recall.get(b.id)! || a.dueAt.getTime() - b.dueAt.getTime())
		.slice(0, limit)
		.map((c) => c.id)
	const joined = ids.length
		? await tx
				.select({ card: cards, reading: readings.title, section: sections.title })
				.from(cards)
				.leftJoin(sections, eq(sections.id, cards.sectionId))
				.leftJoin(readings, eq(readings.id, cards.readingId))
				.where(inArray(cards.id, ids))
		: []
	const rows = ids.map((id) => joined.find((r) => r.card.id === id)!)
	const own = ids.length ? await tx.select().from(questions).where(and(inArray(questions.cardId, ids), isNull(questions.retiredAt))) : []
	const qIds = own.map((q) => q.id)
	const asked = qIds.length
		? await tx
				.select({ id: reviewLog.questionId, at: max(reviewLog.reviewedAt) })
				.from(reviewLog)
				.where(inArray(reviewLog.questionId, qIds))
				.groupBy(reviewLog.questionId)
		: []
	const last = ids.length
		? await tx
				.selectDistinctOn([reviewLog.cardId], { cardId: reviewLog.cardId, questionId: reviewLog.questionId })
				.from(reviewLog)
				.where(inArray(reviewLog.cardId, ids))
				.orderBy(reviewLog.cardId, desc(reviewLog.id))
		: []
	const [key] = await tx.select({ provider: aiKeys.provider }).from(aiKeys).limit(1)

	const items = rows.map(({ card, reading, section }): ReviewItem => {
		const base = {
			cardId: card.id,
			kind: card.kind,
			source: reading ? { reading, section } : null,
			createdAt: card.createdAt,
			answer: card.answer,
			cue: card.prompt,
		}
		if (!key) return { ...base, ask: { kind: 'self', prompt: card.prompt } }
		const choices = own
			.filter((q) => q.cardId === card.id && isQuestionType(q.type))
			.map((q) => ({ id: q.id, level: q.level, lastAskedAt: asked.find((a) => a.id === q.id)?.at ?? null }))
		const picked = own.find((q) => q.id === pickQuestion(choices, card.level, last.find((l) => l.cardId === card.id)?.questionId ?? null))
		if (!picked || !isQuestionType(picked.type)) return { ...base, ask: { kind: 'cue', prompt: card.prompt } }
		const { prompt } = toPrompt(picked.type, picked.content)
		return { ...base, ask: { kind: 'question', questionId: picked.id, type: picked.type, prompt: prompt.prompt, code: prompt.code ?? null } }
	})
	return { items, total: due.length, minutes: await minutesFor(tx, due.length) }
}
