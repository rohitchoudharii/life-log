import { randomUUID } from 'node:crypto'
import { defaultScheduler, FSRS_DEFAULT_WEIGHTS, type Rating, schedulerFor } from '@life-log-club/domain'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { asUser, ownerDb, ownerPool, pool } from '../db/client'
import { prepareDatabase } from '../db/prepare'
import { cards, preferences, reviewLog, schedulerFits, users } from '../db/schema'
import { fitSchedule, MIN_TUNING_REVIEWS, type TuningAnswer, tuneMember, tuningOf } from './tune'

beforeAll(prepareDatabase)
afterAll(() => Promise.all([pool.end(), ownerPool.end()]))

const DAY = 86_400_000
const start = new Date('2026-01-05T09:00:00Z')

/** A learner who forgets much faster than the default parameters expect. */
const FAST = [...FSRS_DEFAULT_WEIGHTS]
FAST.splice(0, 4, 0.05, 0.1, 0.3, 1)
// …and whose memory grows more slowly with each right answer.
FAST[8] = 0.6

function random(seed: number) {
	return () => {
		seed = (seed * 1664525 + 1013904223) % 4294967296
		return seed / 4294967296
	}
}

/**
 * Answers as Review would have them: the default parameters choose each due time, and the
 * learner's true memory (`truth`) decides whether each answer is right. Cards start half a day
 * apart. Before `changeAt` the memory is `truth`; from then on it is `after`.
 */
function simulate({ truth, after = truth, changeAt = Infinity, cardCount = 260, answersPerCard = 6, seed = 1 }: { truth: number[]; after?: number[]; changeAt?: number; cardCount?: number; answersPerCard?: number; seed?: number }) {
	const rnd = random(seed)
	const memories = [schedulerFor(0.9, truth), schedulerFor(0.9, after)]
	const answers: TuningAnswer[] = []
	for (let c = 0; c < cardCount; c++) {
		const cardId = randomUUID()
		let at = new Date(start.getTime() + c * DAY * 0.5)
		let scheduled = defaultScheduler.initial()
		let true_ = [defaultScheduler.initial(), defaultScheduler.initial()]
		for (let k = 0; k < answersPerCard; k++) {
			const which = at.getTime() < changeAt ? 0 : 1
			const p = k === 0 ? 0.7 : (memories[which]!.retrievability(true_[which]!, at) ?? 0.7)
			const rating: Rating = rnd() < p ? (rnd() < 0.15 ? 'hard' : 'good') : 'again'
			answers.push({ cardId, rating, at })
			true_ = true_.map((s, i) => memories[i]!.next(s, rating, at).state)
			const next = defaultScheduler.next(scheduled, rating, at)
			scheduled = next.state
			at = next.dueAt
		}
	}
	return answers
}

it('fits nothing below 1,000 answers', async () => {
	const answers = simulate({ truth: FAST, cardCount: 150 })
	expect(answers.length).toBeLessThan(MIN_TUNING_REVIEWS)
	expect(await fitSchedule(answers, null)).toBeNull()
})

it('keeps new parameters when they predict the held-out answers better, and only then', async () => {
	// A learner who forgets fast all along: a fit on older answers predicts newer ones better.
	const better = await fitSchedule(simulate({ truth: FAST }), null)
	expect(better).toMatchObject({ kept: true, heldOut: expect.any(Number) })
	expect(better!.newLogLoss).toBeLessThan(better!.currentLogLoss)
	expect(better!.weights).not.toEqual([...FSRS_DEFAULT_WEIGHTS])
	expect(better!.reviews + better!.heldOut).toBe(260 * 5)
	expect(better!.heldOut).toBe(260)

	// A learner whose memory changed: what the older answers teach does not hold for the newer ones.
	const changeAt = start.getTime() + 100 * DAY
	const worse = await fitSchedule(simulate({ truth: FAST, after: [...FSRS_DEFAULT_WEIGHTS], changeAt, seed: 2 }), null)
	expect(worse!.newLogLoss).toBeGreaterThanOrEqual(worse!.currentLogLoss)
	expect(worse!.kept).toBe(false)
})

it('a kept fit schedules the member’s next answers with their own parameters; a worse one leaves them as they were', async () => {
	const [user] = await ownerDb.insert(users).values({ email: `tune-${randomUUID()}@example.com`, name: 'T' }).returning()
	const userId = user!.id
	const store = async (answers: TuningAnswer[]) => {
		const ids = [...new Set(answers.map((a) => a.cardId))]
		await ownerDb.insert(cards).values(ids.map((id) => ({ id, userId, kind: 'idea' as const, prompt: 'Why?', answer: 'Because.', state: defaultScheduler.initial(), startedAt: start })))
		await ownerDb.insert(reviewLog).values(answers.map((a) => ({ userId, cardId: a.cardId, rating: a.rating, reviewedAt: a.at, mode: 'review' as const, nextDueAt: a.at })))
	}
	expect(await tuningOf(userId)).toEqual({ reviews: 0, needed: 1000, tuned: false, last: null })
	await store(simulate({ truth: FAST, cardCount: 150 }))
	expect(await tuneMember(userId)).toBeNull()
	expect(await ownerDb.select().from(schedulerFits).where(eq(schedulerFits.userId, userId))).toEqual([])

	await store(simulate({ truth: FAST, seed: 3 }).map((a) => ({ ...a, at: new Date(a.at.getTime() + 200 * DAY) })))
	const fit = await tuneMember(userId)
	expect(fit!.kept).toBe(true)
	const [prefs] = await ownerDb.select().from(preferences).where(eq(preferences.userId, userId))
	expect(prefs!.fsrsWeights).toEqual(fit!.weights)
	expect(await tuningOf(userId)).toMatchObject({ tuned: true, last: { kept: true, improvement: expect.any(Number) } })
	expect((await tuningOf(userId)).last!.improvement).toBeGreaterThan(0)

	// Tuned again on the same answers, the parameters in use can't be beaten: the try is logged and nothing changes.
	const again = await tuneMember(userId)
	expect(again!.currentLogLoss).toBeLessThanOrEqual(again!.newLogLoss)
	expect(again!.kept).toBe(false)
	const [still] = await ownerDb.select().from(preferences).where(eq(preferences.userId, userId))
	expect(still!.fsrsWeights).toEqual(fit!.weights)
	expect(await asUser(userId, (tx) => tx.select({ kept: schedulerFits.kept }).from(schedulerFits).orderBy(schedulerFits.id))).toEqual([{ kept: true }, { kept: false }])
})
