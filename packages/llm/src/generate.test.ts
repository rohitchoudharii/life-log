import { describe, expect, it } from 'vitest'
import { judgeAnswer, planBatches, writeQuestions, type LlmProvider, type SectionInput } from './index'

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

	it('splits the batch in half when the reply is cut off', async () => {
		const one = (n: number, q: object) => JSON.stringify({ sections: [{ section: n, ideas: ['i'], questions: [q] }] })
		const { provider, asked } = scripted('{"sections": [{"section": 1, "questions": [', one(1, good), one(2, goodHeads))
		const out = await writeQuestions(provider, 'k', 'm', sections, [0, 1], prefs)
		expect(asked).toHaveLength(3)
		expect(out.questions.map((q) => q.section)).toEqual([0, 1])
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
