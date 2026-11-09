import { describe, expect, it } from 'vitest'
import { type Rating, replaySchedule, stepsThenFsrs } from './scheduler'

const DAY = 86_400_000
const t0 = new Date('2026-01-01T09:00:00Z')

describe('stepsThenFsrs', () => {
	const exact = stepsThenFsrs({ fuzz: false })
	type Step = { rating: Rating; afterDays?: number }
	/** Answers each rating when the card is due (or `afterDays` after the last answer), and keeps every gap in days. */
	const run = (ratings: (Rating | Step)[], s = exact, start = s.initial(), from = t0) => {
		let state = start
		let now = from
		let due = from
		const gaps: number[] = []
		for (const r of ratings) {
			const { rating, afterDays } = typeof r === 'string' ? { rating: r, afterDays: undefined } : r
			now = afterDays === undefined ? due : new Date(now.getTime() + afterDays * DAY)
			const out = s.next(state, rating, now)
			gaps.push(Math.round(((out.dueAt.getTime() - now.getTime()) / DAY) * 10000) / 10000)
			state = out.state
			due = out.dueAt
		}
		return { state, gaps, now: due }
	}
	const MIN10 = Math.round((10 / (24 * 60)) * 10000) / 10000

	it('Got it four times gives 1, 2 and 3 days, then a gap from FSRS at 90% recall', () => {
		const { gaps, state } = run(['good', 'good', 'good', 'good'])
		expect(gaps.slice(0, 3)).toEqual([1, 2, 3])
		expect(state).toMatchObject({ step: null, relearning: null, reps: 4, lapses: 0 })
		// The fourth gap is FSRS's own: the recall it predicts at that gap is the 90% target.
		expect(gaps[3]).toBeGreaterThan(3)
		const atDue = exact.retrievability(state, new Date(Date.parse(state.lastReviewAt!) + gaps[3]! * DAY))!
		expect(atDue).toBeGreaterThan(0.88)
		expect(atDue).toBeLessThan(0.92)
	})

	it('updates the FSRS memory on every answer, the steps included', () => {
		const one = run(['good'])
		expect(one.state.memory).not.toBeNull()
		const three = run(['good', 'good', 'good'])
		expect(three.state.memory!.stability).toBeGreaterThan(one.state.memory!.stability)
		expect(exact.retrievability(exact.initial(), t0)).toBeNull()
	})

	it('in the steps, Forgot starts over in 10 minutes and Hard repeats the gap without moving on', () => {
		expect(run(['good', 'again']).gaps).toEqual([1, MIN10])
		expect(run(['good', 'again']).state).toMatchObject({ step: 0, lapses: 0 })
		const hard = run(['good', 'hard', 'good'])
		expect(hard.gaps).toEqual([1, 1, 2])
		expect(hard.state.step).toBe(2)
	})

	it('a lapse after graduation comes back in 10 minutes, then 1 day, then from FSRS, and counts once', () => {
		const graduated = run(['good', 'good', 'good', 'good'])
		const lapse = run(['again', 'again', 'good', 'hard', 'good'], exact, graduated.state, graduated.now)
		expect(lapse.gaps.slice(0, 4)).toEqual([MIN10, MIN10, 1, 1])
		expect(lapse.state).toMatchObject({ step: null, relearning: null, lapses: 1 })
		// FSRS cut the stability, so the next gap is much shorter than before the lapse.
		expect(lapse.gaps[4]).toBeGreaterThanOrEqual(1)
		expect(lapse.gaps[4]).toBeLessThan(graduated.gaps[3]!)
		// Not the three steps again: Got it after the 1-day check goes straight back to FSRS.
		expect(run(['again', 'good', 'good'], exact, graduated.state, graduated.now).state.relearning).toBeNull()
	})

	it('never schedules more than 365 days ahead, with or without fuzz', () => {
		const easy = Array.from({ length: 12 }, () => 'easy' as const)
		for (const s of [exact, stepsThenFsrs()]) {
			const { gaps } = run(['good', 'good', 'good', ...easy], s)
			expect(Math.max(...gaps)).toBe(365)
		}
		expect(Math.max(...run(['good', 'good', 'good', ...easy], stepsThenFsrs({ maxIntervalDays: 30, fuzz: false })).gaps)).toBe(30)
	})

	it('a higher target recall gives shorter gaps', () => {
		const at = (desiredRetention: number) => run(['good', 'good', 'good', 'good', 'good'], stepsThenFsrs({ desiredRetention, fuzz: false })).gaps.at(-1)!
		expect(at(0.95)).toBeLessThan(at(0.9))
		expect(at(0.9)).toBeLessThan(at(0.8))
	})

	it('fuzzes FSRS gaps by up to 15%, the same way each time for the same answers', () => {
		const answers: Rating[] = ['good', 'good', 'good', 'good', 'good']
		const fuzzy = stepsThenFsrs()
		const plain = run(answers).gaps.at(-1)!
		const once = run(answers, fuzzy)
		expect(run(answers, fuzzy).gaps).toEqual(once.gaps)
		expect(once.gaps.slice(0, 3)).toEqual([1, 2, 3])
		// Cards answered at different times spread around the plain gap.
		const spread = new Set(Array.from({ length: 20 }, (_, k) => run(answers, fuzzy, fuzzy.initial(), new Date(t0.getTime() + k * 60_000)).gaps.at(-1)))
		expect(spread.size).toBeGreaterThan(1)
		// FSRS fuzzes a gap of 3 to 20 days by up to 15%, give or take the rounding to whole days.
		for (const gap of spread) expect(Math.abs(gap! - plain)).toBeLessThanOrEqual(Math.ceil(plain * 0.15) + 1)
	})
})

describe('replaySchedule', () => {
	const s = stepsThenFsrs()
	const at = (days: number) => new Date(t0.getTime() + days * DAY)
	const good = (days: number, mode: 'recall' | 'review' = 'review') => ({ rating: 'good' as const, correct: true, at: at(days), mode })

	it('replays good ×4, each when due, to the 1, 2 and 3 day steps and then an FSRS gap', () => {
		const answers = [good(0), good(1), good(3), good(6)]
		const out = replaySchedule(answers, s)!
		expect(out.state).toMatchObject({ step: null, reps: 4, lapses: 0, lastReviewAt: at(6).toISOString() })
		expect(out.state.memory).not.toBeNull()
		const gap = (out.dueAt.getTime() - at(6).getTime()) / DAY
		expect(gap).toBeGreaterThan(3)
		// The same as answering live, with the same fuzz.
		let live = s.initial()
		let due = t0
		for (const a of answers) ({ state: live, dueAt: due } = s.next(live, a.rating, a.at))
		expect(out).toEqual({ state: live, dueAt: due })
	})

	it('gives the same result every time it runs', () => {
		const answers = [good(0), { rating: 'again' as const, correct: false, at: at(0.5), mode: 'review' as const }, good(0.6), good(2)]
		expect(replaySchedule(answers, s)).toEqual(replaySchedule(answers, s))
	})

	it('skips a right recall answer given before the card was due, but not a wrong one, and reads a missing verdict from the rating', () => {
		const sameSitting = replaySchedule([good(0, 'recall'), { rating: 'good', correct: null, at: at(0.001), mode: 'recall' }], s)!
		expect(sameSitting).toEqual(replaySchedule([good(0, 'recall')], s))
		const wrongLater = replaySchedule([good(0, 'recall'), { rating: 'again', correct: null, at: at(0.002), mode: 'recall' }], s)!
		expect(wrongLater.state.step).toBe(0)
		expect(replaySchedule([], s)).toBeNull()
	})

	it('counts a review answer the old scheduler took even when this one would have it due later', () => {
		// The old ease scheduler had this card due 8 days after the third step; FSRS here gives more.
		const steps = [good(0), good(1), good(3), good(6)]
		const fsrsDue = replaySchedule(steps, s)!.dueAt
		const reviewedAt = at(14)
		expect(fsrsDue.getTime()).toBeGreaterThan(reviewedAt.getTime())
		const out = replaySchedule([...steps, good(14)], s)!
		expect(out.state.reps).toBe(5)
		expect(out.state.lastReviewAt).toBe(reviewedAt.toISOString())
	})
})
