import { defaultScheduler, lintCue } from '@life-log-club/domain'
import { ideaCueRequest, parseCue } from '@life-log-club/llm'
import { ORPCError } from '@orpc/server'
import { and, eq, isNull } from 'drizzle-orm'
import { asUser, type Tx } from '../db/client'
import { aiKeys, cards, readings, sections } from '../db/schema'
import { callAi, withinBudget } from './ai'

const DAY = 24 * 60 * 60 * 1000

export type SaveIdea = {
	id: string
	readingId: string
	sectionId: string
	block?: number
	quote: string
	prompt?: string
	answer?: string
}

/** "From Peak, The gold standard: what did you save here?" An article's one section has the reading's title. */
const fallbackCue = (title: string, section: string) => `From ${section && section !== title ? `${title}, ${section}` : title}: what did you save here?`

/**
 * Saves a passage of a reading as an idea card, in its section. The answer is the member's words,
 * else the quote; the cue is their question, else a fallback until the AI writes one. Saving is a
 * study event, so the card starts at step 1, due in a day. The same quote saved again from the
 * same reading returns the first card. Returns the card, and whether its cue is for the AI to write.
 */
export async function saveIdea(tx: Tx, userId: string, input: SaveIdea) {
	// Foreign keys skip row-level security, so the reading and section are looked up here, where
	// only the member's own are found.
	const [place] = await tx
		.select({ title: readings.title, section: sections.title })
		.from(sections)
		.innerJoin(readings, eq(readings.id, sections.readingId))
		.where(and(eq(sections.id, input.sectionId), eq(readings.id, input.readingId), isNull(readings.deletedAt)))
	if (!place) throw new ORPCError('NOT_FOUND', { message: 'That reading does not exist. It may have been removed.' })

	// A selection keeps the line breaks between paragraphs; the quote is kept as one run of text.
	const quote = input.quote.replace(/\s+/g, ' ').trim()
	const [same] = await tx
		.select()
		.from(cards)
		.where(and(eq(cards.readingId, input.readingId), eq(cards.quote, quote), eq(cards.origin, 'member'), eq(cards.kind, 'idea'), isNull(cards.deletedAt)))
	if (same) return { card: same, needsCue: false }

	const now = new Date()
	const [created] = await tx
		.insert(cards)
		.values({
			id: input.id,
			userId,
			kind: 'idea',
			origin: 'member',
			readingId: input.readingId,
			sectionId: input.sectionId,
			quote,
			details: input.block === undefined ? null : { block: input.block },
			prompt: input.prompt ?? fallbackCue(place.title, place.section),
			answer: input.answer ?? quote,
			state: { ...defaultScheduler.initial(), step: 1 },
			startedAt: now,
			dueAt: new Date(now.getTime() + DAY),
		})
		.onConflictDoNothing()
		.returning()
	if (!created) {
		const [existing] = await tx.select().from(cards).where(eq(cards.id, input.id))
		if (!existing) throw new ORPCError('CONFLICT', { message: 'That card id is taken. Try again.' })
		return { card: existing, needsCue: false }
	}
	const needsCue = !input.prompt && (await tx.select({ id: aiKeys.userId }).from(aiKeys)).length > 0
	return { card: created, needsCue }
}

export type IdeaCueJob = { userId: string; cardId: string }

/**
 * Asks the member's AI for a cue for an idea saved without a question, and uses it when it passes
 * the checks a key idea's cue passes. Background work, so it stops at the budget. The card keeps
 * its fallback cue when the AI fails, the cue is bad, or the member wrote a question meanwhile.
 */
export async function writeIdeaCue({ userId, cardId }: IdeaCueJob) {
	if (!(await withinBudget(userId))) return
	const [row] = await asUser(userId, (tx) =>
		tx
			.select({ card: cards, title: readings.title })
			.from(cards)
			.innerJoin(readings, eq(readings.id, cards.readingId))
			.where(and(eq(cards.id, cardId), isNull(cards.deletedAt))),
	)
	const quote = row?.card.quote
	if (!row || !quote) return
	const { card } = row
	const words = card.answer === quote ? null : card.answer
	const reply = await callAi(userId, 'write-cue', (model) => ideaCueRequest(model, { title: row.title, quote, words }))
	const cue = reply && parseCue(reply)
	if (!cue || lintCue(cue, `${quote} ${words ?? ''}`).length) return
	await asUser(userId, (tx) => tx.update(cards).set({ prompt: cue }).where(and(eq(cards.id, card.id), eq(cards.prompt, card.prompt))))
}
