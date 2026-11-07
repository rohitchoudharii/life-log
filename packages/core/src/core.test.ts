import { describe, expect, it } from 'vitest'
import { gradeResponse, normalizeOutput, parseNumber, shuffleSteps, localDay, pickQuestion, reviewIdea, startIdea, type IdeaSchedule, isDuplicatePrompt, lintQuestion, orderForTest, parseMarkdown, scoreRubric, shuffleMcq, splitSections, stepsThenEase, subtreeEnd, toPrompt, withConfidence } from './index'

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
		// The later parts are subsections of the first, so picking it picks the whole text.
		expect(sections.map((s) => s.level)).toEqual([1, 2, 2])
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

	it('accepts a typed guess with an MCQ pick, and spaces a right answer called a guess like a hard one', async () => {
		const right = await gradeResponse('mcq', mcq, { choice: 1, guess: 'the square root of d_k' }, noJudge)
		const wrong = await gradeResponse('mcq', mcq, { choice: 0 }, noJudge)
		expect(withConfidence(right, 'guessing')).toMatchObject({ correct: true, rating: 'hard' })
		expect(withConfidence(right, 'think_so').rating).toBe('good')
		expect(withConfidence(right, null).rating).toBe('good')
		// Confidence only lowers credit: a wrong answer stays a miss however it was rated.
		expect(withConfidence(wrong, 'guessing')).toMatchObject({ correct: false, rating: 'again' })
		expect(withConfidence(wrong, 'sure')).toMatchObject({ correct: false, rating: 'again' })
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
		expect(await gradeResponse('worked_problem', wp, { value: '2.54 ms' }, noJudge)).toMatchObject({ correct: true, rating: 'good' })
		expect(await gradeResponse('worked_problem', wp, { value: '2.56' }, noJudge)).toMatchObject({ correct: false, rating: 'again' })
		expect(await gradeResponse('worked_problem', wp, { value: 'two and a half' }, noJudge)).toMatchObject({ correct: false, reveal: { given: null } })
		// A wrong number stays wrong however good the working; the working only explains where it went wrong.
		const judged = await gradeResponse('worked_problem', wp, { value: '3', working: 'w' }, async (input) => {
			expect(input.mustHave).toEqual(['a', 'b'])
			return { score: 4, feedback: 'Step two slipped.', points: ['covered', 'covered'] }
		})
		expect(judged).toMatchObject({ correct: false, rating: 'again', reveal: { feedback: 'Step two slipped.' } })
	})

	it('grades predicted output ignoring spacing, but not line breaks', async () => {
		const po = { prompt: 'What does it print?', code: 'print(1, 2)\nprint(3)', output: '1 2\n3', explanation: '' }
		expect(toPrompt('predict_output', po)).toEqual({ type: 'predict_output', prompt: { prompt: po.prompt, code: po.code } })
		expect(await gradeResponse('predict_output', po, { output: '\n1  2 \r\n3\n' }, noJudge)).toMatchObject({ correct: true })
		expect(await gradeResponse('predict_output', po, { output: '1 2 3' }, noJudge)).toMatchObject({ correct: false, reveal: { output: '1 2\n3' } })
		expect(normalizeOutput('a\t b\n\n')).toBe('a b')
	})

	it('shows steps shuffled and grades the order the learner gives against the right one', async () => {
		const os = { prompt: 'Order the steps of a request.', steps: ['A', 'B', 'C', 'D'], shown: [2, 0, 3, 1], explanation: '' }
		expect(toPrompt('order_steps', os).prompt).toEqual({ prompt: os.prompt, code: undefined, steps: ['C', 'A', 'D', 'B'] })
		// Positions in the shown list: A is shown second, B fourth, C first, D third.
		expect(await gradeResponse('order_steps', os, { order: [1, 3, 0, 2] }, noJudge)).toMatchObject({ correct: true, rating: 'good' })
		expect(await gradeResponse('order_steps', os, { order: [0, 1, 2, 3] }, noJudge)).toMatchObject({ correct: false, rating: 'again' })
		// One neighbouring pair swapped out of six pairs is close, but not right.
		expect(await gradeResponse('order_steps', os, { order: [3, 1, 0, 2] }, noJudge)).toMatchObject({ correct: false, rating: 'hard' })
		await expect(gradeResponse('order_steps', os, { order: [1, 1, 0, 2] }, noJudge)).rejects.toThrow()
		for (let k = 0; k < 20; k++) expect(shuffleSteps({ steps: ['a', 'b', 'c'] }).shown).not.toEqual([0, 1, 2])
	})
})

describe('word tests', () => {
	const w = { word: 'saturate', form: 'Saturating', sentence: 'Scaling keeps softmax from Saturating on large scores.', meaning: 'pushing almost all weight onto one option' }
	const noJudge = async () => {
		throw new Error('judge must not be called')
	}

	it('blanks the word where it appears and accepts it back in either form, with one typo in a long word', async () => {
		expect(toPrompt('word_cloze', w).prompt).toEqual({ prompt: 'Which word fills the blank?', sentence: 'Scaling keeps softmax from _____ on large scores.', hint: 'Starts with "S", 10 letters' })
		for (const answer of ['saturating', 'Saturate.', 'saturatng']) expect((await gradeResponse('word_cloze', w, { answer }, noJudge)).correct).toBe(true)
		for (const answer of ['saturated it', 'collapse']) expect((await gradeResponse('word_cloze', w, { answer }, noJudge)).correct).toBe(false)
	})

	it('grades meaning and use with the judge, against the meaning in context', async () => {
		const seen: string[][] = []
		const judge = async (input: { mustHave: string[] }) => (seen.push(input.mustHave), { score: 4 as const, feedback: 'ok', points: input.mustHave.map(() => 'covered' as const) })
		expect(await gradeResponse('word_meaning', w, { answer: 'all weight on one thing' }, judge)).toMatchObject({ correct: true, reveal: { meaning: w.meaning } })
		await gradeResponse('word_use', w, { answer: 'The flood saturated the field.' }, judge)
		expect(seen[0]).toEqual([w.meaning])
		expect(seen[1]![0]).toMatch(/Uses "saturate".*pushing almost all weight/)
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

	it('rejects code in the prompt, code copied from the text, and steps that give away their order', () => {
		const code = 'for i in range(3):\n    total = total + i * i\nprint(total)'
		const withCode = `The text runs this loop.\n\n${code}`
		const po = (prompt: string, c: string) => lintQuestion({ type: 'predict_output', level: 'apply', content: { prompt, code: c, output: '5' } }, withCode)
		expect(po('What does it print if total starts at 0?', code.replace('3', '4'))).toEqual([])
		expect(po('What does it print if total starts at 0?', code).join()).toMatch(/copies the text's own code/)
		expect(po('What does `print(total)` show?', code.replace('3', '4')).join()).toMatch(/backticks/)
		const steps = (s: string[]) => lintQuestion({ type: 'order_steps', level: 'recall', content: { prompt: 'Put the request in order.', steps: s } }, source)
		expect(steps(['DNS lookup', 'TCP handshake', 'TLS handshake', 'HTTP request'])).toEqual([])
		expect(steps(['First, DNS lookup', 'TCP handshake', 'TLS handshake', 'HTTP request']).join()).toMatch(/position/)
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

describe('orderForTest', () => {
	it('puts written before multiple choice, and missed ideas before vague and remembered ones', () => {
		const q = (id: string, type: 'short_answer' | 'mcq', ideaId: string | null) => ({ id, type, ideaId })
		const recall = new Map([
			['a', 'covered'],
			['b', 'missing'],
			['c', 'vague'],
		] as const)
		const order = orderForTest(
			[q('mcq-missed', 'mcq', 'b'), q('sa-covered', 'short_answer', 'a'), q('sa-none', 'short_answer', null), q('sa-vague', 'short_answer', 'c'), q('sa-missed', 'short_answer', 'b'), q('mcq-covered', 'mcq', 'a')],
			recall,
			() => 0.5,
		)
		expect(order.map((x) => x.id)).toEqual(['sa-missed', 'sa-vague', 'sa-covered', 'sa-none', 'mcq-missed', 'mcq-covered'])
	})
})

describe('reviewIdea', () => {
	const tz = 'Asia/Kolkata'
	type Step = { at: Date; correct: boolean }
	const run = (steps: Step[], level: 'recall' | 'apply' = 'recall') => {
		let cur = { schedule: startIdea(level, localDay(steps[0]!.at, tz)), dueAt: steps[0]!.at }
		const out: { schedule: IdeaSchedule; dueAt: Date }[] = []
		for (const { at, correct } of steps) {
			cur = reviewIdea(cur, { correct, rating: correct ? 'good' : 'again' }, at, localDay(at, tz))
			out.push(cur)
		}
		return out
	}
	const at = (iso: string) => new Date(iso)

	it('moves the level up when right and down when wrong, within the five levels', () => {
		const levels = run([
			{ at: at('2026-01-01T09:00:00Z'), correct: true },
			{ at: at('2026-01-02T09:00:00Z'), correct: true },
			{ at: at('2026-01-04T09:00:00Z'), correct: false },
			{ at: at('2026-01-04T10:00:00Z'), correct: false },
			{ at: at('2026-01-04T11:00:00Z'), correct: false },
		]).map((r) => r.schedule.level)
		expect(levels).toEqual([1, 2, 1, 0, 0])
		expect(run([{ at: t0, correct: true }], 'apply')[0]!.schedule.level).toBe(3)
	})

	it('ignores a right answer before the idea is due, but not a wrong one', () => {
		const [first, sameTestRight, sameTestWrong] = run([
			{ at: t0, correct: true },
			{ at: new Date(t0.getTime() + 60_000), correct: true },
			{ at: new Date(t0.getTime() + 120_000), correct: false },
		])
		expect(sameTestRight).toEqual(first)
		expect(sameTestWrong!.schedule.level).toBe(0)
		expect(sameTestWrong!.dueAt.getTime() - t0.getTime()).toBe(120_000 + 10 * 60_000)
	})

	it('is learned after 3 right days after the first, then comes back monthly; a miss restarts the count', () => {
		const days = ['2026-01-01', '2026-01-02', '2026-01-04', '2026-01-07'].map((d) => ({ at: at(`${d}T09:00:00Z`), correct: true }))
		const out = run(days)
		expect(out.map((r) => r.schedule.mastered)).toEqual([false, false, false, true])
		expect((out[3]!.dueAt.getTime() - days[3]!.at.getTime()) / DAY).toBe(30)
		const lapsed = run([...days, { at: at('2026-02-06T09:00:00Z'), correct: false }]).at(-1)!
		expect(lapsed.schedule).toMatchObject({ mastered: false, correctDays: [] })
	})

	it('counts days in the learner\'s timezone, so 30 minutes across local midnight are two days', () => {
		// 18:20 and 18:50 UTC are 23:50 on 1 January and 00:20 on 2 January in India.
		let cur = { schedule: startIdea('recall', '2025-12-31'), dueAt: at('2026-01-01T18:20:00Z') }
		cur = reviewIdea(cur, { correct: true, rating: 'good' }, at('2026-01-01T18:20:00Z'), localDay(at('2026-01-01T18:20:00Z'), tz))
		cur = reviewIdea({ ...cur, dueAt: at('2026-01-01T18:50:00Z') }, { correct: true, rating: 'good' }, at('2026-01-01T18:50:00Z'), localDay(at('2026-01-01T18:50:00Z'), tz))
		expect(cur.schedule.correctDays).toEqual(['2026-01-01', '2026-01-02'])
		expect(localDay(at('2026-01-01T18:50:00Z'), 'America/New_York')).toBe('2026-01-01')
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
