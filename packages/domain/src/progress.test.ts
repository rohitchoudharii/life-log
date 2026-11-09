import { describe, expect, it } from 'vitest'
import { gapBucket, ideaStatus } from './progress'
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
