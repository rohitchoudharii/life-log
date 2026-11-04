import { describe, expect, it } from 'vitest'
import { gradeResponse, isDuplicatePrompt, lintQuestion, parseMarkdown, scoreRubric, shuffleMcq, splitSections, stepsThenEase, subtreeEnd, toPrompt } from './index'

const DAY = 86_400_000
const t0 = new Date('2026-01-01T09:00:00Z')

describe('stepsThenEase', () => {
	const s = stepsThenEase()
	const run = (ratings: ('again' | 'hard' | 'good' | 'easy')[]) => {
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
})

describe('parseMarkdown and splitSections', () => {
	it('starts a section at each heading and keeps code and lists intact', () => {
		const blocks = parseMarkdown(
			'Intro line\n\n# Attention\nQueries meet keys.\n\n```py\nx = 1\n\ny = 2\n```\n- one\n- two\n\n## Heads\n1. a\n2. b',
		)
		const sections = splitSections(blocks, 'My note')
		expect(sections.map((s) => s.title)).toEqual(['My note', 'Attention', 'Heads'])
		expect(sections[1]!.blocks).toEqual([
			{ type: 'paragraph', text: 'Queries meet keys.' },
			{ type: 'code', language: 'py', text: 'x = 1\n\ny = 2' },
			{ type: 'list', ordered: false, items: ['one', 'two'] },
		])
		expect(sections[2]!.blocks).toEqual([{ type: 'list', ordered: true, items: ['a', 'b'] }])
	})

	it('nests headings up to three levels without skipping a level, keeping empty parents', () => {
		// The document starts at ##, jumps from ## to ####, and has a chapter with no text of its own.
		const md = '## Part A\n\n### Ch 1\nText one.\n\n##### Deep\nText deep.\n\n## Part B\nIntro B.\n\n### Ch 2\nText two.'
		const sections = splitSections(parseMarkdown(md), 'Doc')
		expect(sections.map((s) => [s.title, s.level])).toEqual([
			['Part A', 1],
			['Ch 1', 2],
			['Deep', 3],
			['Part B', 1],
			['Ch 2', 2],
		])
		const levels = sections.map((s) => s.level)
		expect(subtreeEnd(levels, 0)).toBe(3)
		expect(subtreeEnd(levels, 1)).toBe(3)
		expect(subtreeEnd(levels, 2)).toBe(3)
		expect(subtreeEnd(levels, 3)).toBe(5)
		const deep = splitSections(parseMarkdown('# A\na\n## B\nb\n### C\nc\n#### D\nd'), 'Doc')
		expect(deep.map((s) => s.level)).toEqual([1, 2, 3, 3])
	})

	it('cuts long text without headings into parts at paragraph boundaries', () => {
		const para = Array.from({ length: 200 }, () => 'word').join(' ')
		const sections = splitSections(parseMarkdown(Array(6).fill(para).join('\n\n')), 'Long')
		expect(sections.map((s) => s.wordCount)).toEqual([400, 400, 400])
		expect(sections.map((s) => s.title)).toEqual(['Long', 'Long (part 2)', 'Long (part 3)'])
	})
})

describe('question types', () => {
	const mcq = { prompt: 'Scale factor?', options: ['d_k', '√d_k', '1/d_k'], answerIndex: 1, explanation: 'Divide by √d_k.', whyWrong: ['Too large.', '', 'Inverted.'] }
	const noJudge = async () => {
		throw new Error('judge must not be called')
	}

	it('hides the MCQ answer key and grades it without the judge', async () => {
		expect(toPrompt('mcq', mcq)).toEqual({ type: 'mcq', prompt: { prompt: 'Scale factor?', options: mcq.options } })
		expect(await gradeResponse('mcq', mcq, { choice: 0 }, noJudge)).toMatchObject({ correct: false, rating: 'again', reveal: { answerIndex: 1, whyWrong: 'Too large.' } })
		expect(await gradeResponse('mcq', mcq, { choice: 1 }, noJudge)).toMatchObject({ correct: true, rating: 'good' })
	})

	const sa = { prompt: 'Why scale?', reference: 'Keeps softmax gradients from vanishing.', mustHave: [], niceToHave: [], misconceptions: [] }

	it('hides the short-answer reference and maps the judge score to a rating', async () => {
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

describe('lintQuestion', () => {
	const source = 'Scores come from query times key, scaled by the square root of the key size, so softmax does not saturate.'
	const sa = (prompt: string, mustHave: string[], level = 'explain' as const) => lintQuestion({ type: 'short_answer', level, content: { prompt, mustHave } }, source)

	it('passes a why-question that does not give the answer away', () => {
		expect(sa('Why would attention break down for large key sizes without the scaling step?', ['dot products grow with key size', 'softmax saturates and gradients vanish'])).toEqual([])
	})

	it('rejects definition prompts, copied sentences, and prompts that contain a must-have point', () => {
		expect(sa('Explain self-attention in your own words.', ['a', 'b'])).toHaveLength(2)
		expect(sa('What is softmax?', ['a', 'b'])).toHaveLength(1)
		expect(sa('True or false: scores come from query times key, scaled by the square root of the key size?', ['x', 'y']).join()).toMatch(/copies/)
		expect(sa('How does scaling scores by the square root of key size keep softmax from saturating?', ['scaling by square root of key size', 'softmax saturating'])).not.toEqual([])
	})

	it('rejects multiple choice with a giveaway option or missing reasons', () => {
		const mcq = (options: string[], whyWrong = ['', 'w', 'w', 'w']) =>
			lintQuestion({ type: 'mcq', level: 'apply', content: { prompt: 'Which change keeps softmax from saturating?', options, answerIndex: 0, whyWrong } }, source)
		expect(mcq(['Divide by √d_k', 'Multiply by d_k', 'Add d_k', 'Square the scores'])).toEqual([])
		expect(mcq(['Dividing each score by the square root of the key dimension before softmax', 'Add d_k', 'Use ReLU', 'Square it']).join()).toMatch(/longest/)
		expect(mcq(['Divide by √d_k', 'Multiply by d_k', 'None of the above', 'Add d_k']).join()).toMatch(/above/)
		expect(mcq(['Divide by √d_k', 'Multiply by d_k', 'Add d_k', 'Square'], ['', '', '', '']).join()).toMatch(/reason/)
	})

	it('treats reworded prompts with the same content words as duplicates, but not different questions', () => {
		expect(isDuplicatePrompt('Why does softmax saturate for large scores?', 'For large scores, why does softmax saturate?')).toBe(true)
		expect(isDuplicatePrompt('Why does softmax saturate for large scores?', 'How do multiple heads share the model dimension?')).toBe(false)
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
})
