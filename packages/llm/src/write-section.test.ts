import { describe, expect, it } from 'vitest'
import { type Complete, MAX_IDEAS, writeSection } from './write-section'

const section = {
	title: 'Spacing',
	wordCount: 120,
	text: 'Recall after a gap is harder than recall right away. The effort of pulling a memory back is what makes it last. Cramming feels fluent but fades within days.',
}
const question = (prompt: string) => ({
	type: 'short_answer',
	level: 'explain',
	content: { prompt, reference: 'Harder recall builds a stronger memory.', mustHave: ['effortful retrieval strengthens memory', 'easy rereading gives little practice'], misconceptions: [] },
})
const idea = (n: number, extra: Record<string, unknown> = {}) => ({
	section: 1,
	rank: n,
	idea: `Idea number ${n} about memory.`,
	cue: `Which point number ${n} did the part make?`,
	quote: 'The effort of pulling a memory back is what makes it last.',
	questions: [question(`Why would a student who waits ${n} days before testing keep more?`)],
	...extra,
})

/**
 * A model that answers each task from a script, and records which tasks were called. A list
 * gives one reply per call, in order.
 */
function scripted(replies: Record<string, unknown>) {
	const calls: string[] = []
	const complete: Complete = async (purpose, request) => {
		calls.push(purpose)
		expect(request('m').system.startsWith(`Task: ${purpose}`)).toBe(true)
		const reply = replies[purpose]
		return JSON.stringify((Array.isArray(reply) ? reply.shift() : reply) ?? {})
	}
	return { complete, calls }
}

describe('writeSection', () => {
	it('drops an idea whose quote is not in the text, or whose cue gives it away', async () => {
		const { complete } = scripted({
			'write-section': {
				ideas: [
					idea(1),
					idea(2, { quote: 'Sleep moves memories from one part of the brain to another.' }),
					idea(3, { idea: 'Cramming feels fluent but fades within days.', cue: 'Why does cramming feel fluent but fade within days?' }),
				],
			},
		})
		const written = await writeSection(complete, [section], { amount: 'standard', qualityCheck: false })
		expect(written.ideas.map((i) => i.idea)).toEqual(['Idea number 1 about memory.'])
		expect(written.rejected.map((r) => r.reasons.join())).toEqual([expect.stringMatching(/quote is not in the text/), expect.stringMatching(/gives the idea away/)])
	})

	it('keeps the 20 most important ideas and the rest as spare, most important first', async () => {
		const many = Array.from({ length: MAX_IDEAS + 2 }, (_, i) => idea(MAX_IDEAS + 2 - i))
		const { complete } = scripted({ 'write-section': { ideas: many } })
		const written = await writeSection(complete, [section], { amount: 'quick', qualityCheck: false })
		expect(written.ideas).toHaveLength(MAX_IDEAS)
		expect(written.ideas[0]!.idea).toBe('Idea number 1 about memory.')
		expect(written.spare.map((i) => i.idea)).toEqual(['Idea number 21 about memory.', 'Idea number 22 about memory.'])
		// Quick writes no questions.
		expect(written.ideas.every((i) => i.questions.length === 0)).toBe(true)
	})

	it('sends a question that breaks the rules or fails the check back once, and keeps a good replacement', async () => {
		const { complete, calls } = scripted({
			'write-section': { ideas: [idea(1, { questions: [question('What is spacing?')] }), idea(2)] },
			'check-questions': [{ checks: [{ id: 1, verdict: 'reject', problems: ['the answer key is wrong'] }] }, { checks: [{ id: 1, verdict: 'keep' }] }],
			'rewrite-questions': { questions: [{ id: 1, ...question('How would a week between tests change what a learner keeps?') }] },
		})
		const written = await writeSection(complete, [section], { amount: 'standard', qualityCheck: true })
		expect(calls).toEqual(['write-section', 'check-questions', 'rewrite-questions', 'check-questions'])
		// Idea 1's question was a definition; idea 2's failed the check. One rewrite came back and passed.
		expect(written.ideas.map((i) => i.questions.map((q) => (q.content as { prompt: string }).prompt))).toEqual([
			['How would a week between tests change what a learner keeps?'],
			[],
		])
	})

	it('puts an idea in the section its quote is in, when sections are written together', async () => {
		const short = { title: 'Intro', wordCount: 30, text: 'Most of what we read is gone within a week of reading it.' }
		const { complete } = scripted({ 'write-section': { ideas: [idea(1, { section: 1 })] } })
		const written = await writeSection(complete, [short, section], { amount: 'quick', qualityCheck: false })
		expect(written.ideas[0]!.section).toBe(1)
	})

	it('refuses a reply that is not JSON', async () => {
		const complete: Complete = async () => 'Sorry, I cannot help with that.'
		await expect(writeSection(complete, [section], { amount: 'standard', qualityCheck: false })).rejects.toThrow(/key ideas/)
	})
})
