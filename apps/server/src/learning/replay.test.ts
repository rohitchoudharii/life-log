import { randomUUID } from 'node:crypto'
import { replaySchedule, type SchedulerState } from '@life-log-club/domain'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { ownerDb, ownerPool, pool } from '../db/client'
import { prepareDatabase } from '../db/prepare'
import { cards, reviewLog, users } from '../db/schema'
import { replaySchedules } from './replay'

beforeAll(prepareDatabase)
afterAll(() => Promise.all([pool.end(), ownerPool.end()]))

const DAY = 86_400_000
const now = new Date()
const ago = (days: number) => new Date(now.getTime() - days * DAY)
/** The shape cards had under the ease scheduler, before this one. */
const easeState = (step: number | null, intervalDays: number) => ({ step, intervalDays, ease: 2.5, reps: 0, lapses: 0 }) as unknown as SchedulerState

it('replays each card from its answers, once and the same every time, and only touches what it should', async () => {
	const [user] = await ownerDb.insert(users).values({ email: `replay-${randomUUID()}@example.com`, name: 'R' }).returning()
	const userId = user!.id
	const card = (id: string, state: SchedulerState, dueAt: Date, startedAt: Date | null) => ({ id, userId, kind: 'idea' as const, prompt: 'Why?', answer: 'Because.', state, dueAt, startedAt, level: 2 })
	const ids = { graduated: randomUUID(), inSteps: randomUUID(), fresh: randomUUID(), sameSitting: randomUUID() }
	await ownerDb.insert(cards).values([
		// Good four times, each when due: graduated, and due again 8 days on under the ease rules, so due now.
		card(ids.graduated, easeState(null, 8), ago(1), ago(15)),
		// Good once, 2 days ago, so due a day ago under both schedulers. Its start time was never set.
		card(ids.inSteps, easeState(1, 1), new Date(ago(2).getTime() + DAY), null),
		card(ids.fresh, easeState(0, 0), ago(3), null),
		card(ids.sameSitting, easeState(1, 1), new Date(ago(5).getTime() + DAY), ago(5)),
	])
	const answer = (cardId: string, at: Date, rating: 'good' | 'again', mode: 'review' | 'recall' | 'practice' = 'review', correct: boolean | null = null) => ({
		userId,
		cardId,
		answerId: randomUUID(),
		rating,
		correct,
		mode,
		reviewedAt: at,
		nextDueAt: at,
	})
	await ownerDb.insert(reviewLog).values([
		answer(ids.graduated, ago(15), 'good', 'recall'),
		answer(ids.graduated, ago(14), 'good'),
		answer(ids.graduated, ago(12), 'good'),
		answer(ids.graduated, ago(9), 'good'),
		answer(ids.inSteps, ago(2), 'good', 'recall'),
		// A retry round answer never moved the schedule, so the replay leaves it out.
		answer(ids.inSteps, ago(1.9), 'again', 'practice'),
		// Two questions on one idea in one sitting: the second right answer changes nothing.
		answer(ids.sameSitting, ago(5), 'good', 'recall', true),
		answer(ids.sameSitting, new Date(ago(5).getTime() + 60_000), 'good', 'recall', true),
	])

	const report = await replaySchedules({ userId, now })
	// Due before: the graduated card and the same-sitting one. After: the graduated card is days
	// away, and the card whose start time was missing counts now that it has one.
	expect(report).toEqual({ cards: 4, replayed: 3, graduated: 1, graduatedWithMemory: 1, dueBefore: 2, dueAfter: 2, dueAtChangedInSteps: 0 })
	const rows = async () => Object.fromEntries((await ownerDb.select().from(cards).where(eq(cards.userId, userId))).map((c) => [c.id, c]))
	const after = await rows()

	const expected = replaySchedule([ago(15), ago(14), ago(12), ago(9)].map((at) => ({ rating: 'good' as const, correct: null, at, mode: 'review' as const })))!
	expect(after[ids.graduated]).toMatchObject({ state: expected.state, dueAt: expected.dueAt, level: 2 })
	expect(after[ids.graduated]!.state.memory).not.toBeNull()
	// The FSRS gap after the steps is longer than the ease rules' 8 days, so it is no longer due.
	expect(expected.dueAt.getTime()).toBeGreaterThan(now.getTime())

	expect(after[ids.inSteps]).toMatchObject({ state: { step: 1, reps: 1 }, startedAt: ago(2), dueAt: new Date(ago(2).getTime() + DAY) })
	expect(after[ids.fresh]).toMatchObject({ state: { step: 0, reps: 0, memory: null }, dueAt: ago(3), startedAt: null })
	expect(after[ids.sameSitting]!.state).toMatchObject({ step: 1, reps: 1 })

	// A second run changes nothing, and the log is untouched.
	const log = await ownerDb.select().from(reviewLog).where(eq(reviewLog.userId, userId))
	await replaySchedules({ userId, now })
	expect(await rows()).toEqual(after)
	expect(await ownerDb.select().from(reviewLog).where(eq(reviewLog.userId, userId))).toEqual(log)
	// Cards already in the current shape are skipped by the server's start-up run.
	expect((await replaySchedules({ userId, onlyOld: true, now })).cards).toBe(0)
})
