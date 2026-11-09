import { randomUUID } from 'node:crypto'
import { defaultScheduler, lintCue } from '@life-log-club/domain'
import { lessonCueRequest, parseLessonCue } from '@life-log-club/llm'
import { and, eq } from 'drizzle-orm'
import { asUser, type Tx } from '../db/client'
import { aiKeys, cards, type entries } from '../db/schema'
import { callAi, withinBudget } from './ai'

type Entry = typeof entries.$inferSelect

/** "Salary talks: what's the lesson?" */
const fromCue = (cue: string) => `${cue}: what's the lesson?`

/** "Your lesson from 3 Nov: what was it?", until a cue is written. Days are in UTC. */
const fallbackCue = (at: Date) =>
	`Your lesson from ${at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })}: what was it?`

const cueOf = (entry: Entry) => (entry.details as { cue?: string }).cue

/**
 * Makes the review card for a lesson just logged, in the same transaction as the entry. It is
 * started and due at once. Returns whether the card still needs a cue written by AI: true when
 * the member gave none and has a key.
 */
export async function addLessonCard(tx: Tx, entry: Entry) {
	const cue = cueOf(entry)
	await tx.insert(cards).values({
		id: randomUUID(),
		userId: entry.userId,
		kind: 'lesson',
		entryId: entry.id,
		prompt: cue ? fromCue(cue) : fallbackCue(entry.occurredAt),
		answer: entry.text ?? '',
		state: defaultScheduler.initial(),
		startedAt: new Date(),
	})
	return !cue && (await tx.select({ id: aiKeys.userId }).from(aiKeys)).length > 0
}

/**
 * Keeps a lesson's card in step with an edit of its entry: the text is the answer, and a new cue
 * becomes the prompt. The schedule stays, so an edit after reviews doesn't start it over.
 */
export async function updateLessonCard(tx: Tx, before: Entry, after: Entry) {
	const cue = cueOf(after)
	const set = {
		...(after.text !== before.text && { answer: after.text ?? '' }),
		...(cue && cue !== cueOf(before) && { prompt: fromCue(cue) }),
	}
	if (Object.keys(set).length) await tx.update(cards).set(set).where(eq(cards.entryId, after.id))
}

/** Hides a lesson's card with its entry (`at` a date), or brings it back with it (`at` null). */
export const hideLessonCard = (tx: Tx, entryId: string, at: Date | null) => tx.update(cards).set({ deletedAt: at }).where(eq(cards.entryId, entryId))

export type CueJob = { userId: string; entryId: string }

/**
 * Asks the member's AI for a cue for a lesson logged without one, and uses it when it passes the
 * same checks as a key idea's cue. Background work, so it stops at the budget. The card keeps
 * its date cue when the AI fails, the cue is bad, or the member gave a cue meanwhile.
 */
export async function writeLessonCue({ userId, entryId }: CueJob) {
	if (!(await withinBudget(userId))) return
	const [card] = await asUser(userId, (tx) => tx.select().from(cards).where(eq(cards.entryId, entryId)))
	if (!card) return
	const reply = await callAi(userId, 'lesson-cue', (model) => lessonCueRequest(model, card.answer))
	const cue = reply && parseLessonCue(reply)
	if (!cue || lintCue(cue, card.answer).length) return
	await asUser(userId, (tx) => tx.update(cards).set({ prompt: cue }).where(and(eq(cards.id, card.id), eq(cards.prompt, card.prompt))))
}
