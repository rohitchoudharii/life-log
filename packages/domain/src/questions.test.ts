import { describe, expect, it } from 'vitest'
import { answerIdea, pickQuestion } from './ideas'
import { gradeResponse, parseQuestionContent, scoreRubric, toPrompt } from './questions'
import { stepsThenEase } from './scheduler'

// Ported from the previous app (packages/core/src/core.test.ts at 4051df5^).
describe('short answer questions', () => {
	const noJudge = async () => {
		throw new Error('judge must not be called')
	}
	const sa = { prompt: 'Why scale?', reference: 'Keeps softmax gradients from vanishing.', mustHave: [], niceToHave: [], misconceptions: [] }

	it('hides the reference answer and maps the judge score to a rating', async () => {
		expect(toPrompt('short_answer', sa)).toEqual({ type: 'short_answer', prompt: { prompt: 'Why scale?' } })
		const graded = (score: 0 | 1 | 2 | 3 | 4) =>
			gradeResponse('short_answer', sa, { answer: 'gradients' }, async (input) => {
				// A question without a checklist is graded against its reference answer as the only point.
				expect(input).toEqual({ question: 'Why scale?', reference: sa.reference, mustHave: [sa.reference], misconceptions: [], answer: 'gradients' })
				return { score, feedback: 'f' }
			})
		expect((await Promise.all([0, 1, 2, 3, 4].map((n) => graded(n as 0)))).map((g) => [g.rating, g.correct])).toEqual([
			['again', false],
			['again', false],
			['hard', false],
			['good', true],
			['easy', true],
		])
	})

	it('"I don\'t know" counts as a miss without calling the judge', async () => {
		expect(await gradeResponse('short_answer', sa, { skipped: true }, noJudge)).toMatchObject({ rating: 'again', reveal: { reference: sa.reference } })
	})

	it('rejects a blank answer or a response of the wrong shape', async () => {
		expect(() => gradeResponse('short_answer', sa, { answer: '   ' }, noJudge)).toThrow()
		expect(() => gradeResponse('short_answer', sa, { choice: 1 }, noJudge)).toThrow()
	})

	it('accepts AI content only when it fits a known type', () => {
		expect(parseQuestionContent('short_answer', { prompt: 'Why?', reference: 'Because.' })).toMatchObject({ mustHave: [], misconceptions: [] })
		expect(parseQuestionContent('short_answer', { prompt: 'Why?' })).toBeNull()
		expect(parseQuestionContent('mcq', { prompt: 'Which?', options: ['a', 'b'], answerIndex: 0 })).toBeNull()
	})
})

describe('scoreRubric', () => {
	it('needs every point, precisely, for full marks and caps a stated misconception at 1', () => {
		expect(scoreRubric(['covered', 'covered', 'covered'], false)).toBe(4)
		expect(scoreRubric(['covered', 'vague', 'covered'], false)).toBe(3)
		// Two vague points is not "right with a small gap".
		expect(scoreRubric(['covered', 'vague', 'vague'], false)).toBe(2)
		expect(scoreRubric(['covered', 'missing', 'missing', 'missing'], false)).toBe(1)
		expect(scoreRubric(['covered', 'covered', 'missing', 'missing'], false)).toBe(2)
		expect(scoreRubric(['missing', 'missing'], false)).toBe(0)
		expect(scoreRubric(['covered', 'covered', 'covered'], true)).toBe(1)
	})
})

describe('answerIdea', () => {
	const t0 = new Date('2026-01-01T09:00:00Z')
	const s = stepsThenEase()
	const start = (level = 0) => ({ state: s.initial(), level, dueAt: t0 })
	const right = { correct: true, rating: 'good' } as const
	const wrong = { correct: false, rating: 'again' } as const

	it('moves the level up when right and down when wrong, within the five levels', () => {
		let cur = start()
		const levels: number[] = []
		for (const grade of [right, right, wrong, wrong, wrong]) {
			cur = answerIdea({ ...cur, dueAt: new Date(0) }, grade, t0, s)
			levels.push(cur.level)
		}
		expect(levels).toEqual([1, 2, 1, 0, 0])
		expect(answerIdea(start(4), right, t0, s).level).toBe(4)
	})

	it('ignores a right answer before the card is due, but not a wrong one', () => {
		const first = answerIdea(start(), right, t0, s)
		const sameSittingRight = answerIdea(first, right, new Date(t0.getTime() + 60_000), s)
		const sameSittingWrong = answerIdea(first, wrong, new Date(t0.getTime() + 120_000), s)
		expect(sameSittingRight).toEqual(first)
		expect(sameSittingWrong.level).toBe(0)
		expect(sameSittingWrong.dueAt.getTime() - t0.getTime()).toBe(120_000 + 10 * 60_000)
	})
})

describe('pickQuestion', () => {
	const q = (id: string, level: 'recall' | 'explain' | 'apply' | 'analyze' | null, asked: string | null = null) => ({ id, level, lastAskedAt: asked ? new Date(asked) : null })

	it('takes an unasked question at the level, else the nearest, preferring easier', () => {
		expect(pickQuestion([q('a', 'recall'), q('b', 'apply'), q('c', 'explain')], 2, null)).toBe('b')
		expect(pickQuestion([q('a', 'analyze'), q('b', 'explain')], 2, null)).toBe('b')
		expect(pickQuestion([q('a', 'apply', '2026-01-01'), q('b', 'analyze')], 2, null)).toBe('b')
	})

	it('returns null when every question was asked, and with reuse never repeats the last one', () => {
		const asked = [q('a', 'apply', '2026-01-03'), q('b', 'apply', '2026-01-01'), q('c', 'apply', '2026-01-02')]
		expect(pickQuestion(asked, 2, 'b')).toBeNull()
		expect(pickQuestion(asked, 2, 'b', true)).toBe('c')
		expect(pickQuestion([q('a', 'apply', '2026-01-03')], 2, 'a', true)).toBe('a')
	})
})
