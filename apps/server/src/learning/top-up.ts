import { QUESTION_LEVELS } from '@life-log-club/domain'
import { type Complete, WRITE_SECTION_PROMPT_VERSION, writeQuestions } from '@life-log-club/llm'
import { and, asc, eq, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm'
import { asUser } from '../db/client'
import { aiKeys, cards, questions, reviewLog, sections } from '../db/schema'
import { callAi, withinBudget } from './ai'
import { preferencesOf } from './preferences'
import { NoKey, toText } from './write-section'

const DAY = 24 * 60 * 60 * 1000

/** Cards due within this long get a fresh question before they come back. */
export const TOP_UP_AHEAD_DAYS = 2
/** A card gets at most one new question in this many days. */
export const TOP_UP_EVERY_DAYS = 7
/** Cards written for in one AI call, and calls in one run. */
const PER_CALL = 8
const CALLS_PER_RUN = 3

export type TopUpJob = { userId: string }

/**
 * The cards that need a fresh question now: started ideas from a reading, due within
 * TOP_UP_AHEAD_DAYS, every question of which has been asked already, and none of which was
 * written in the last TOP_UP_EVERY_DAYS days. Soonest due first.
 */
export function cardsToTopUp(userId: string, now: Date, limit: number) {
	const unasked = sql`exists (
		select 1 from ${questions} q where q.card_id = ${cards.id} and q.retired_at is null
		and not exists (select 1 from ${reviewLog} l where l.question_id = q.id)
	)`
	const recent = sql`exists (select 1 from ${questions} q where q.card_id = ${cards.id} and q.created_at > ${new Date(now.getTime() - TOP_UP_EVERY_DAYS * DAY)})`
	return asUser(userId, (tx) =>
		tx
			.select({ card: cards, section: sections })
			.from(cards)
			.innerJoin(sections, eq(sections.id, cards.sectionId))
			.where(
				and(
					eq(cards.kind, 'idea'),
					isNull(cards.deletedAt),
					isNotNull(cards.startedAt),
					lte(cards.dueAt, new Date(now.getTime() + TOP_UP_AHEAD_DAYS * DAY)),
					sql`not ${unasked}`,
					sql`not ${recent}`,
				),
			)
			.orderBy(asc(cards.dueAt))
			.limit(limit),
	)
}

/**
 * The `top-up-questions` job: writes one fresh question, at the card's level, for each card
 * that would otherwise be asked through its cue again when it comes back (`cardsToTopUp`).
 * Background work, so it is skipped without a key, past the monthly budget, and on Quick,
 * where ideas are meant to come back through their cues. Returns how many questions it wrote.
 */
export async function topUpQuestions({ userId }: TopUpJob, now = new Date()): Promise<number> {
	const ready = await asUser(userId, async (tx) => {
		const [key] = await tx.select({ userId: aiKeys.userId }).from(aiKeys)
		return key ? preferencesOf(tx, userId) : null
	})
	if (!ready || ready.questionAmount === 'quick' || !(await withinBudget(userId))) return 0
	const due = await cardsToTopUp(userId, now, PER_CALL * CALLS_PER_RUN)
	if (!due.length) return 0
	const asked = await asUser(userId, (tx) =>
		tx
			.select({ cardId: questions.cardId, content: questions.content })
			.from(questions)
			.where(inArray(questions.cardId, due.map((d) => d.card.id))),
	)
	const complete: Complete = async (purpose, request) => {
		const reply = await callAi(userId, purpose, request)
		if (reply === null) throw new NoKey()
		return reply
	}
	let written = 0
	for (let start = 0; start < due.length; start += PER_CALL) {
		// Each call stops at the budget too, so a long backlog doesn't run past it.
		if (start && !(await withinBudget(userId))) break
		const batch = due.slice(start, start + PER_CALL)
		const sectionIds = [...new Set(batch.map((d) => d.section.id))]
		const texts = sectionIds.map((id) => toText(batch.find((d) => d.section.id === id)!.section))
		const asks = batch.map(({ card, section }) => ({
			section: sectionIds.indexOf(section.id),
			idea: card.answer,
			cue: card.prompt,
			quote: card.quote ?? '',
			asked: asked.filter((q) => q.cardId === card.id).map((q) => String(q.content.prompt ?? '')),
			// Stored questions are above recall: the cue already asks for recall.
			level: QUESTION_LEVELS[Math.max(1, card.level)],
		}))
		let out: Awaited<ReturnType<typeof writeQuestions>>
		try {
			out = await writeQuestions(complete, texts, asks, { amount: ready.questionAmount, style: ready.questionStyle, qualityCheck: ready.qualityCheck }, 1)
		} catch (error) {
			// Without a key, or with the provider failing, cards are asked through their cues as before.
			if (error instanceof NoKey) return written
			throw error
		}
		const rows = batch.flatMap(({ card }, i) =>
			(out.questions[i] ?? []).map((q) => ({
				userId,
				cardId: card.id,
				readingId: card.readingId,
				sectionId: card.sectionId,
				type: q.type,
				level: q.level,
				content: q.content as Record<string, unknown>,
				promptVersion: WRITE_SECTION_PROMPT_VERSION,
			})),
		)
		if (rows.length) await asUser(userId, (tx) => tx.insert(questions).values(rows))
		written += rows.length
	}
	return written
}

