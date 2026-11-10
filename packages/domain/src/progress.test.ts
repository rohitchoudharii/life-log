import { describe, expect, it } from 'vitest'
import { gapBucket, goalPace, ideaStatus } from './progress'
import { stepsThenFsrs } from './scheduler'

const DAY = 86_400_000

describe('ideaStatus', () => {
	const s = stepsThenFsrs({ fuzz: false })
	const t0 = new Date('2026-01-01T09:00:00Z')
	const at = (days: number) => new Date(t0.getTime() + days * DAY)
	const graduated = [0, 1, 3, 6].reduce((state, d) => s.next(state, 'good', at(d)).state, s.initial())

	it('is new before the first answer, learning in the steps, then known until recall falls below 85%', () => {
		expect(ideaStatus({ startedAt: null, state: s.initial() }, t0)).toBe('new')
		expect(ideaStatus({ startedAt: t0, state: s.next(s.initial(), 'good', t0).state }, at(30))).toBe('learning')
		expect(graduated.step).toBeNull()
		// Just after the last answer recall is near 100%; months later it has fallen well below 85%.
		expect(ideaStatus({ startedAt: t0, state: graduated }, at(6.1))).toBe('known')
		expect(ideaStatus({ startedAt: t0, state: graduated }, at(400))).toBe('fading')
		const day = [...Array(400).keys()].find((d) => ideaStatus({ startedAt: t0, state: graduated }, at(6 + d)) === 'fading')!
		expect(s.retrievability(graduated, at(6 + day))).toBeLessThan(0.85)
		expect(s.retrievability(graduated, at(6 + day - 1))).toBeGreaterThanOrEqual(0.85)
	})
})

describe('gapBucket', () => {
	it('puts each step in its own group, a few hours either way, then longer gaps by weeks and months', () => {
		expect([0.4, 1, 1.4].map(gapBucket)).toEqual(['1d', '1d', '1d'])
		expect([1.6, 2.4].map(gapBucket)).toEqual(['2d', '2d'])
		expect([2.6, 3.4].map(gapBucket)).toEqual(['3d', '3d'])
		expect([3.6, 28, 28.4].map(gapBucket)).toEqual(['month', 'month', 'month'])
		expect([28.6, 91].map(gapBucket)).toEqual(['quarter', 'quarter'])
		expect([91.6, 365].map(gapBucket)).toEqual(['longer', 'longer'])
	})
})

describe('goalPace', () => {
	it('spreads the words left over the days to the goal, today included, in pages of 300 words', () => {
		// 30,000 words, 9,000 read: 21,000 left = 70 pages, over 7 days (today to the 16th) = 10 a day.
		expect(goalPace({ wordCount: 30_000, wordsRead: 9_000, goalBy: '2026-11-16', today: '2026-11-10' })).toEqual({ percent: 30, passed: false, pagesPerDay: 10 })
		// A part page rounds up, so the goal is met.
		expect(goalPace({ wordCount: 30_000, wordsRead: 9_000, goalBy: '2026-11-17', today: '2026-11-10' }).pagesPerDay).toBe(9)
		// The goal day itself still counts; the day after, the goal has passed.
		expect(goalPace({ wordCount: 600, wordsRead: 0, goalBy: '2026-11-10', today: '2026-11-10' })).toEqual({ percent: 0, passed: false, pagesPerDay: 2 })
		expect(goalPace({ wordCount: 600, wordsRead: 0, goalBy: '2026-11-09', today: '2026-11-10' })).toEqual({ percent: 0, passed: true })
		expect(goalPace({ wordCount: 600, wordsRead: 600, goalBy: '2026-12-01', today: '2026-11-10' })).toEqual({ percent: 100, passed: false, pagesPerDay: 0 })
	})
})
