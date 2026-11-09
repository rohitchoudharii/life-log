import { describe, expect, it } from 'vitest'
import { type Rating, stepsThenEase, stepsThenFsrs } from './scheduler'

const DAY = 86_400_000
const t0 = new Date('2026-01-01T09:00:00Z')

// Ported unchanged from the previous app (packages/core/src/core.test.ts at 639219c).
describe('stepsThenEase', () => {
	const s = stepsThenEase()
	const run = (ratings: Rating[]) => {
		let state = s.initial()
		let now = t0
		const gaps: number[] = []
		for (const r of ratings) {
			const out = s.next(state, r, now)
			gaps.push((out.dueAt.getTime() - now.getTime()) / DAY)
			state = out.state
			now = out.dueAt
		}
		return { state, gaps }
	}

	it('repeats after 1, 2, and 3 days, then grows by the ease factor', () => {
		const { gaps, state } = run(['good', 'good', 'good', 'good', 'good'])
		expect(gaps).toEqual([1, 2, 3, 8, 20])
		expect(state.step).toBeNull()
	})

	it('hard stays on the current step instead of graduating', () => {
		const { gaps, state } = run(['good', 'good', 'hard', 'hard'])
		expect(gaps).toEqual([1, 2, 2, 2])
		expect(state.step).toBe(2)
	})

	it('a lapse after graduating restarts the steps and lowers ease', () => {
		const { state, gaps } = run(['good', 'good', 'good', 'again', 'good'])
		expect(gaps[3]! * 24 * 60).toBeCloseTo(10)
		expect(gaps[4]).toBe(1)
		expect(state).toMatchObject({ lapses: 1, ease: 2.3, step: 1 })
	})

	it('never schedules further out than a year', () => {
		const { gaps } = run(Array<Rating>(12).fill('easy'))
		expect(Math.max(...gaps)).toBe(365)
	})
})

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
