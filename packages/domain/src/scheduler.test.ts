import { describe, expect, it } from 'vitest'
import { type Rating, stepsThenEase } from './scheduler'

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
