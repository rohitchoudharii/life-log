import { describe, expect, it } from 'vitest'
import { explainPassage, extractJson, judgeAnswer, planBatches, teachTurn, writeQuestions, type LlmProvider, type SectionInput } from './index'

/** A provider that replies with the given texts in order and records what it was asked. */
const scripted = (...replies: string[]) => {
	const asked: string[] = []
	const provider: LlmProvider = {
		id: 'anthropic',
		listModels: async () => [],
		suggestModel: () => undefined,
		complete: async (_key, req) => {
			asked.push(req.user)
			const next = replies.shift()
			if (next === undefined) throw new Error('unexpected call')
			return next
		},
	}
	return { provider, asked }
}

describe('planBatches', () => {
	const s = (level: number, wordCount: number) => ({ level, wordCount })

	it('keeps a chapter with its subsections and fills calls with whole chapters', () => {
		// Standard: 350 words → 5 questions → 1750 tokens per section. Budget fits 6 sections.
		const sections = [s(1, 350), s(2, 350), s(2, 350), s(1, 350), s(2, 350), s(1, 350), s(2, 350), s(2, 350)]
		expect(planBatches(sections, 'standard', 6 * 1750)).toEqual([
			[0, 1, 2, 3, 4],
			[5, 6, 7],
		])
	})

	it('splits a chapter too big for one reply in reading order, and skips empty headings alone', () => {
		const sections = [s(1, 0), s(2, 350), s(2, 350), s(2, 350), s(1, 0)]
		expect(planBatches(sections, 'standard', 2 * 1750)).toEqual([[0, 1, 2], [3]])
	})
})

const sections: SectionInput[] = [
	{ title: 'Scaling', level: 1, wordCount: 120, text: 'Scores come from query times key, scaled by the square root of the key size, so softmax does not saturate.' },
	{ title: 'Heads', level: 1, wordCount: 120, text: 'Several heads attend in parallel, each in a smaller subspace, and their outputs are joined.' },
]
const prefs = { intensity: 'standard', style: 'mixed' } as const
const good = {
	type: 'short_answer',
	level: 'explain',
	content: { prompt: 'Why would attention break down for large key sizes without the scaling step?', reference: 'r', mustHave: ['dot products grow with key size', 'softmax saturates'] },
}
const goodHeads = {
	type: 'short_answer',
	level: 'apply',
	content: { prompt: 'A model has one big head instead of eight small ones. What could it no longer do?', reference: 'r', mustHave: ['attend to several relations at once', 'in separate subspaces'] },
}

describe('writeQuestions', () => {
	it('checks questions in code, rewrites the failures once with reasons, and drops what still fails', async () => {
		const banned = { type: 'short_answer', level: 'explain', content: { prompt: 'Explain multi-head attention in your own words.', reference: 'r', mustHave: ['a', 'b'] } }
		const first = JSON.stringify({
			sections: [
				{ section: 1, ideas: ['Scaling keeps softmax from saturating.'], questions: [good, { type: 'mcq', level: 'apply', content: { prompt: 'Which?' } }] },
				{ section: 2, ideas: ['Heads work in parallel subspaces.'], questions: [banned] },
			],
		})
		const fixes = JSON.stringify({ questions: [{ id: 2, ...goodHeads }] })
		const { provider, asked } = scripted(first, fixes)
		const out = await writeQuestions(provider, 'k', 'm', sections, [0, 1], prefs)

		expect(asked[1]).toMatch(/in your own words/)
		expect(asked[1]).toMatch(/does not match the mcq shape/)
		expect(out.questions.map((q) => [q.section, (q.content as { prompt: string }).prompt])).toEqual([
			[0, good.content.prompt],
			[1, goodHeads.content.prompt],
		])
		expect(out.ideas.get(1)).toEqual(['Heads work in parallel subspaces.'])
	})

	it('with the quality check on, rewrites a question whose answer key disagrees with the check working it out', async () => {
		const problem = (answer: number) => ({
			type: 'worked_problem',
			level: 'apply',
			idea: 1,
			content: { prompt: 'Keys have 64 dimensions. By what factor are the scores divided?', answer, tolerance: 0, unit: '', solution: 's', steps: ['take the square root', 'of 64'] },
		})
		const first = JSON.stringify({ sections: [{ section: 1, ideas: ['Scaling keeps softmax from saturating.'], questions: [problem(16), good] }] })
		// The check works it out as 8 and rejects nothing itself; code compares the numbers.
		const check = JSON.stringify({ checks: [{ id: 1, answer: 8, verdict: 'keep' }, { id: 2, verdict: 'keep' }] })
		const fixes = JSON.stringify({ questions: [{ id: 1, ...problem(8) }] })
		const recheck = JSON.stringify({ checks: [{ id: 1, answer: 8, verdict: 'keep' }] })
		const { provider, asked } = scripted(first, check, fixes, recheck)
		const out = await writeQuestions(provider, 'k', 'm', sections, [0], { ...prefs, qualityCheck: true })

		expect(asked[2]).toMatch(/answer key says 16, but working it out gives 8/)
		expect(out.questions.map((q) => [q.type, (q.content as { answer?: number }).answer])).toEqual([
			['short_answer', undefined],
			['worked_problem', 8],
		])
	})

	it('shuffles the steps of an order question before storing them', async () => {
		const steps = ['Compute query-key scores', 'Scale the scores', 'Apply softmax', 'Weight the values']
		const order = { type: 'order_steps', level: 'explain', idea: 1, content: { prompt: 'Put one attention step in order.', steps, explanation: 'e' } }
		const { provider } = scripted(JSON.stringify({ sections: [{ section: 1, ideas: ['i'], questions: [order] }] }))
		const [q] = (await writeQuestions(provider, 'k', 'm', sections, [0], prefs)).questions
		const content = q!.content as { steps: string[]; shown: number[] }
		expect(content.steps).toEqual(steps)
		expect([...content.shown].sort()).toEqual([0, 1, 2, 3])
		expect(content.shown).not.toEqual([0, 1, 2, 3])
	})

	it('asks once more when the reply for a single section is unreadable', async () => {
		const { provider, asked } = scripted('{"sections": [{"section": 1, "questions": [', JSON.stringify({ sections: [{ section: 1, ideas: ['i'], questions: [good] }] }))
		const out = await writeQuestions(provider, 'k', 'm', sections, [0], prefs)
		expect(asked).toHaveLength(2)
		expect(out.questions).toHaveLength(1)
	})

	it('splits the batch in half when the reply is cut off', async () => {
		const one = (n: number, q: object) => JSON.stringify({ sections: [{ section: n, ideas: ['i'], questions: [q] }] })
		const { provider, asked } = scripted('{"sections": [{"section": 1, "questions": [', one(1, good), one(2, goodHeads))
		const out = await writeQuestions(provider, 'k', 'm', sections, [0, 1], prefs)
		expect(asked).toHaveLength(3)
		expect(out.questions.map((q) => q.section)).toEqual([0, 1])
	})
})

describe('extractJson', () => {
	it('reads replies with raw line breaks and tabs inside strings, as models write code', () => {
		const reply = 'Here you go:\n{"prompt": "What does this print?\nfor (let i = 0; i < 2; i++)\n\tconsole.log(i)", "ok": true,\n"note": "a \\"quoted\\" word"}'
		expect(extractJson(reply)).toEqual({ prompt: 'What does this print?\nfor (let i = 0; i < 2; i++)\n\tconsole.log(i)', ok: true, note: 'a "quoted" word' })
	})
})

describe('judgeAnswer', () => {
	const input = { question: 'q', reference: 'r', mustHave: ['p1', 'p2', 'p3', 'p4'], misconceptions: [], answer: 'a' }
	it('computes the score from the points and treats an unreadable point as missing', async () => {
		const { provider } = scripted('{"points": ["covered", "vague"], "misconception": null, "feedback": " Close. "}')
		expect(await judgeAnswer(provider, 'k', 'm', input)).toEqual({ score: 1, points: ['covered', 'vague', 'missing', 'missing'], misconception: null, feedback: 'Close.' })
	})
	it('caps the score at 1 when the answer states a misconception', async () => {
		const { provider } = scripted('{"points": ["covered", "covered", "covered", "covered"], "misconception": "Thinks scaling speeds up training", "feedback": "f"}')
		expect((await judgeAnswer(provider, 'k', 'm', input)).score).toBe(1)
	})
	it('fails instead of guessing when the points are missing', async () => {
		const { provider } = scripted('{"score": 4}')
		await expect(judgeAnswer(provider, 'k', 'm', input)).rejects.toThrow()
	})
})

describe('tutor', () => {
	const section = 'Scores are divided by the square root of the key size. This keeps softmax from saturating.'
	it('keeps a quote only when it really is in the section', async () => {
		const reply = (quote: string) => JSON.stringify({ text: 't', quote })
		const real = scripted(reply('this keeps  softmax from saturating.'), reply('Scaling makes training stable.'))
		const input = { section, passage: 'p', level: 'new', kind: 'explain' } as const
		expect((await explainPassage(real.provider, 'k', 'm', input)).quote).toBe('this keeps  softmax from saturating.')
		expect((await explainPassage(real.provider, 'k', 'm', input)).quote).toBeNull()
	})

	it('makes the student sum up after three follow-ups, and fails rather than lose the gaps', async () => {
		const messages = [
			{ role: 'learner', text: 'a' },
			{ role: 'student', text: 'q1' },
			{ role: 'learner', text: 'b' },
			{ role: 'student', text: 'q2' },
			{ role: 'learner', text: 'c' },
			{ role: 'student', text: 'q3' },
			{ role: 'learner', text: 'd' },
		] as const
		const { provider, asked } = scripted('{"kind": "question", "text": "q4"}')
		await expect(teachTurn(provider, 'k', 'm', { idea: 'i', source: section, messages: [...messages] })).rejects.toThrow(/sum up/)
		expect(asked[0]).toMatch(/no follow-up questions left/)
	})
})
