import { describe, expect, it } from 'vitest'
import { answerIdea, pickQuestion } from './ideas'
import { type Grade, gradeResponse, normalizeOutput, orderForTest, parseNumber, parseQuestionContent, scoreRubric, shuffleMcq, toPrompt, withConfidence } from './questions'
import { stepsThenFsrs } from './scheduler'

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
		expect(parseQuestionContent('mcq', { prompt: 'Which?', options: ['a', 'b'], answerIndex: 2 })).toBeNull()
		expect(parseQuestionContent('mcq', { prompt: 'Which?', options: ['a', 'b'], answerIndex: 1 })).toMatchObject({ explanation: '', whyWrong: [] })
	})
})

describe('multiple choice questions', () => {
	const mcq = { prompt: 'Scale factor?', options: ['d_k', '√d_k', '1/d_k'], answerIndex: 1, explanation: 'Divide by √d_k.', whyWrong: ['Too large.', '', 'Inverted.'] }
	const noJudge = async () => {
		throw new Error('judge must not be called')
	}

	it('hides the MCQ answer key and grades it without the judge', async () => {
		expect(toPrompt('mcq', mcq)).toEqual({ type: 'mcq', prompt: { prompt: 'Scale factor?', options: mcq.options } })
		expect(await gradeResponse('mcq', mcq, { choice: 0 }, noJudge)).toMatchObject({
			correct: false,
			rating: 'again',
			reveal: { reference: 'Divide by √d_k.', choice: { options: mcq.options, right: 1, picked: 0, whyWrong: ['Too large.', '', 'Inverted.'], guess: null } },
		})
		expect(await gradeResponse('mcq', mcq, { choice: 1 }, noJudge)).toMatchObject({ correct: true, rating: 'good' })
		// I don't know is a miss with nothing picked.
		expect(await gradeResponse('mcq', mcq, { skipped: true }, noJudge)).toMatchObject({ correct: false, rating: 'again', reveal: { choice: { picked: null } } })
		expect(() => gradeResponse('mcq', mcq, { answer: 'd_k' }, noJudge)).toThrow()
	})

	it('accepts a typed guess with an MCQ pick, and spaces a right answer called a guess like a hard one', async () => {
		const right = await gradeResponse('mcq', mcq, { choice: 1, guess: 'the square root of d_k' }, noJudge)
		expect(right.reveal).toMatchObject({ choice: { guess: 'the square root of d_k' } })
		const wrong = await gradeResponse('mcq', mcq, { choice: 0 }, noJudge)
		expect(withConfidence(right, 'guessing')).toMatchObject({ correct: true, rating: 'hard' })
		expect(withConfidence(right, 'think_so').rating).toBe('good')
		expect(withConfidence(right, null).rating).toBe('good')
		// Confidence only lowers credit: a wrong answer stays a miss however it was rated.
		expect(withConfidence(wrong, 'guessing')).toMatchObject({ correct: false, rating: 'again' })
		expect(withConfidence(wrong, 'sure')).toMatchObject({ correct: false, rating: 'again' })
	})
})

// Ported from the previous app (packages/core/src/core.test.ts at 4051df5^, "exact question types").
describe('exact question types', () => {
	const noJudge = async () => {
		throw new Error('judge must not be called')
	}

	it('reads the number an answer starts with, ignoring units and thousands commas', () => {
		expect(parseNumber('1,024 bytes')).toBe(1024)
		expect(parseNumber('3/4')).toBe(0.75)
		expect(parseNumber('-3e-4 s')).toBe(-0.0003)
		expect(parseNumber('about 5')).toBeNull()
	})

	it('grades a worked problem by its number, within the tolerance, and judges the working only when given', async () => {
		const wp = { prompt: 'A 4-head layer with d_model 512: what is d_k?', answer: 2.5, tolerance: 0.05, unit: 'ms', solution: 's', steps: ['a', 'b'], misconceptions: [] }
		expect(toPrompt('worked_problem', wp)).toEqual({ type: 'worked_problem', prompt: { prompt: wp.prompt, code: undefined, unit: 'ms' } })
		expect(await gradeResponse('worked_problem', wp, { value: '2.54 ms' }, noJudge)).toMatchObject({ correct: true, rating: 'good', reveal: { exact: { expected: '2.5 ms', given: '2.54 ms' } } })
		expect(await gradeResponse('worked_problem', wp, { value: '2.56' }, noJudge)).toMatchObject({ correct: false, rating: 'again' })
		expect(await gradeResponse('worked_problem', wp, { value: 'two and a half' }, noJudge)).toMatchObject({ correct: false, reveal: { exact: { given: 'two and a half' } } })
		// A wrong number stays wrong however good the working; the working only explains where it went wrong.
		const judged = await gradeResponse('worked_problem', wp, { value: '3', working: 'w' }, async (input) => {
			expect(input.mustHave).toEqual(['a', 'b'])
			return { score: 4, feedback: 'Step two slipped.', points: ['covered', 'covered'] }
		})
		expect(judged).toMatchObject({ correct: false, rating: 'again', reveal: { feedback: 'Step two slipped.' } })
		// Clean working on a right number makes it easy; a judge that fails leaves the number to decide.
		expect(await gradeResponse('worked_problem', wp, { value: '2.5', working: 'w' }, async () => ({ score: 4, feedback: '' }))).toMatchObject({ rating: 'easy' })
		expect(await gradeResponse('worked_problem', wp, { value: '2.5', working: 'w' }, noJudge)).toMatchObject({ correct: true, rating: 'good' })
		expect(await gradeResponse('worked_problem', wp, { skipped: true }, noJudge)).toMatchObject({ correct: false, rating: 'again', reveal: { exact: { given: null } } })
	})

	it('grades predicted output ignoring spacing, but not line breaks', async () => {
		const po = { prompt: 'What does it print?', code: 'print(1, 2)\nprint(3)', output: '1 2\n3', explanation: '' }
		expect(toPrompt('predict_output', po)).toEqual({ type: 'predict_output', prompt: { prompt: po.prompt, code: po.code } })
		expect(await gradeResponse('predict_output', po, { output: '\n1  2 \r\n3\n' }, noJudge)).toMatchObject({ correct: true })
		expect(await gradeResponse('predict_output', po, { output: '1 2 3' }, noJudge)).toMatchObject({ correct: false, reveal: { exact: { expected: '1 2\n3' } } })
		expect(normalizeOutput('a\t b\n\n')).toBe('a b')
	})

	it('judges a found error like a written answer, against what is wrong and why', async () => {
		const fe = { prompt: 'What is wrong with this loop?', code: 'for i in range(1, n): total += i', reference: 'It skips n.', mustHave: ['the range stops before n', 'so n is never added'], misconceptions: [] }
		expect(toPrompt('find_error', fe)).toEqual({ type: 'find_error', prompt: { prompt: fe.prompt, code: fe.code } })
		const graded = await gradeResponse('find_error', fe, { answer: 'range stops at n-1' }, async (input) => {
			expect(input).toMatchObject({ question: `${fe.prompt}\n\n${fe.code}`, mustHave: fe.mustHave })
			return { score: 3, feedback: 'Close.', points: ['covered', 'vague'] }
		})
		expect(graded).toMatchObject({ correct: true, rating: 'good' })
	})
})

describe('shuffleMcq', () => {
	it('moves the right answer and its reasons along with the options', () => {
		const c = { prompt: 'p', options: ['right', 'w1', 'w2', 'w3'], answerIndex: 0, explanation: '', whyWrong: ['', 'r1', 'r2', 'r3'] }
		const out = shuffleMcq(c, () => 0)
		expect(out.options[out.answerIndex]).toBe('right')
		expect(out.answerIndex).not.toBe(0)
		out.options.forEach((o, i) => expect(out.whyWrong[i]).toBe(o === 'right' ? '' : `r${o.slice(1)}`))
	})

	it('spreads the right answer over every position', () => {
		const c = { prompt: 'p', options: ['right', 'w1', 'w2', 'w3'], answerIndex: 0, explanation: '', whyWrong: [] }
		let seed = 1
		// A small seeded generator, so the test is the same every run.
		const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646
		const at = new Set(Array.from({ length: 40 }, () => shuffleMcq(c, random).answerIndex))
		expect([...at].sort()).toEqual([0, 1, 2, 3])
		expect(shuffleMcq(c, random).whyWrong).toEqual([])
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
	const s = stepsThenFsrs({ fuzz: false })
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

describe('withConfidence', () => {
	const grade = (rating: Grade['rating'], correct: boolean): Grade => ({ rating, correct, reveal: {} })

	it('only ever lowers credit: a right guess is hard, and easy needs Sure or no confidence', () => {
		expect(withConfidence(grade('good', true), 'guessing').rating).toBe('hard')
		expect(withConfidence(grade('easy', true), 'guessing').rating).toBe('hard')
		expect(withConfidence(grade('easy', true), 'think_so').rating).toBe('good')
		expect(withConfidence(grade('easy', true), 'sure').rating).toBe('easy')
		expect(withConfidence(grade('easy', true), null).rating).toBe('easy')
		// A wrong answer stays a miss however sure the learner was.
		expect(withConfidence(grade('again', false), 'guessing').rating).toBe('again')
		expect(withConfidence(grade('hard', false), 'sure').rating).toBe('hard')
	})
})

describe('orderForTest', () => {
	it('asks missed ideas first, then vague, then covered', () => {
		const marks = new Map([
			['a', 'covered'],
			['b', 'missing'],
			['c', 'vague'],
			['d', 'missing'],
		] as const)
		const items = ['a', 'b', 'c', 'd'].map((cardId) => ({ cardId, type: cardId === 'b' ? null : ('short_answer' as const) }))
		const order = orderForTest(items, marks).map((q) => q.cardId)
		expect(order.slice(0, 2).sort()).toEqual(['b', 'd'])
		expect(order.slice(2)).toEqual(['c', 'a'])
	})

	it('puts written questions before multiple choice, because options hint at other answers', () => {
		const marks = new Map([
			['a', 'covered'],
			['b', 'missing'],
		] as const)
		const q = (id: string, type: 'short_answer' | 'mcq', cardId: string) => ({ id, type, cardId })
		const order = orderForTest([q('mcq-missed', 'mcq', 'b'), q('sa-covered', 'short_answer', 'a'), q('sa-missed', 'short_answer', 'b'), q('mcq-covered', 'mcq', 'a')], marks)
		expect(order.map((x) => x.id)).toEqual(['sa-missed', 'sa-covered', 'mcq-missed', 'mcq-covered'])
	})
})
