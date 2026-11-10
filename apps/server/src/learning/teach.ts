import type { TeachSession } from '@life-log-club/contract'
import { blockText, safeFollowUp } from '@life-log-club/domain'
import { parseTeachTurn, teachRequest } from '@life-log-club/llm'
import { ORPCError } from '@orpc/server'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { asUser, type Tx } from '../db/client'
import { aiKeys, cards, sections, teachSessions } from '../db/schema'
import { callAi } from './ai'

const NO_KEY = 'Add your own AI key in Settings to teach an idea back.'
const NO_TURN = 'The student could not answer just now. Try again.'
const notFound = () => new ORPCError('NOT_FOUND', { message: 'That teach-back does not exist.' })

type SessionRow = typeof teachSessions.$inferSelect
type CardRow = typeof cards.$inferSelect

function toSession(row: SessionRow, card: CardRow): TeachSession {
	return {
		id: row.id,
		cardId: row.cardId,
		topic: card.prompt,
		messages: row.messages,
		result: row.result ? { ...row.result, idea: card.answer, quote: card.quote, dueAt: row.dueAt } : null,
	}
}

/** A session and its card, the session locked when `lock` is set so one turn is taken at a time. */
async function load(tx: Tx, id: string, lock = false) {
	const query = tx.select().from(teachSessions).innerJoin(cards, eq(cards.id, teachSessions.cardId)).where(eq(teachSessions.id, id))
	const [found] = lock ? await query.for('update', { of: teachSessions }) : await query
	if (!found) throw notFound()
	return { row: found.teach_sessions, card: found.cards }
}

/** What the student checks the learner against: the idea's section, or for an idea with no section its quote. */
async function sourceOf(tx: Tx, card: CardRow) {
	if (card.sectionId) {
		const [section] = await tx.select({ blocks: sections.blocks }).from(sections).where(eq(sections.id, card.sectionId))
		if (section) return section.blocks.map(blockText).filter(Boolean).join('\n\n')
	}
	return card.quote ?? card.answer
}

/** Starts teaching an idea card back. Needs the member's AI key; starting again with the same id returns the same session. */
export function startTeach(userId: string, input: { id: string; cardId: string }) {
	return asUser(userId, async (tx) => {
		const [key] = await tx.select({ userId: aiKeys.userId }).from(aiKeys)
		if (!key) throw new ORPCError('BAD_REQUEST', { message: NO_KEY })
		const [card] = await tx
			.select({ id: cards.id, kind: cards.kind })
			.from(cards)
			.where(and(eq(cards.id, input.cardId), isNull(cards.deletedAt)))
		if (!card) throw new ORPCError('NOT_FOUND', { message: 'That idea does not exist. It may have been removed.' })
		if (card.kind !== 'idea') throw new ORPCError('BAD_REQUEST', { message: 'Only an idea can be taught back.' })
		await tx.insert(teachSessions).values({ id: input.id, userId, cardId: card.id }).onConflictDoNothing()
		const { row, card: own } = await load(tx, input.id)
		if (row.cardId !== card.id) throw new ORPCError('CONFLICT', { message: 'That teach-back is about another idea.' })
		return toSession(row, own)
	})
}

export function getTeach(userId: string, id: string) {
	return asUser(userId, async (tx) => {
		const { row, card } = await load(tx, id)
		return toSession(row, card)
	})
}

/**
 * Takes the learner's message for `turn` and asks the student for its turn: a follow-up, or the
 * summing up once its follow-ups are used. The message is kept before the AI call, so when the
 * call fails the same turn asks again without sending it twice. A summing up with gaps brings the
 * card back within 10 minutes and leaves its memory as it was.
 */
export async function replyTeach(userId: string, input: { id: string; turn: number; text: string }): Promise<TeachSession> {
	const step = await asUser(userId, async (tx) => {
		const { row, card } = await load(tx, input.id, true)
		const sent = row.messages.filter((m) => m.role === 'learner').length
		const waiting = row.messages.at(-1)?.role === 'learner'
		// Finished, or this turn was answered already: a retried request gets the session as it is.
		if (row.result || input.turn < sent - (waiting ? 1 : 0)) return { done: toSession(row, card) }
		if (input.turn > sent || (input.turn === sent && waiting)) throw new ORPCError('CONFLICT', { message: 'This teach-back has moved on. Open it again to carry on.' })
		const messages = input.turn === sent ? [...row.messages, { role: 'learner' as const, text: input.text }] : row.messages
		if (messages !== row.messages) await tx.update(teachSessions).set({ messages }).where(eq(teachSessions.id, row.id))
		return { messages, card, source: await sourceOf(tx, card) }
	})
	if (step.done) return step.done
	const { messages, card, source } = step

	// Outside the transaction: the AI call can take a while, and the learner's message is kept either way.
	let reply: string | null
	try {
		reply = await callAi(userId, 'teach-back', (model) => teachRequest(model, { idea: card.answer, source, messages }))
	} catch {
		throw new ORPCError('SERVICE_UNAVAILABLE', { message: NO_TURN })
	}
	if (reply === null) throw new ORPCError('BAD_REQUEST', { message: NO_KEY })
	const turn = parseTeachTurn(reply, messages)
	if (!turn) throw new ORPCError('SERVICE_UNAVAILABLE', { message: NO_TURN })

	return asUser(userId, async (tx) => {
		const { row } = await load(tx, input.id, true)
		// Another request took this turn while the student was thinking.
		if (row.result || row.messages.length !== messages.length) return toSession(row, card)
		if (turn.kind === 'question') {
			const text = safeFollowUp(turn.text, { quote: card.quote, idea: card.answer })
			const [updated] = await tx
				.update(teachSessions)
				.set({ messages: [...messages, { role: 'student', text }] })
				.where(eq(teachSessions.id, row.id))
				.returning()
			return toSession(updated!, card)
		}
		const { kind: _, ...result } = turn
		let dueAt: Date | null = null
		if (result.gaps.length > 0) {
			const [moved] = await tx
				.update(cards)
				.set({ dueAt: sql`least(${cards.dueAt}, now() + interval '10 minutes')` })
				.where(eq(cards.id, card.id))
				.returning({ dueAt: cards.dueAt })
			dueAt = moved?.dueAt ?? null
		}
		const [updated] = await tx.update(teachSessions).set({ result, dueAt, finishedAt: new Date() }).where(eq(teachSessions.id, row.id)).returning()
		return toSession(updated!, card)
	})
}
