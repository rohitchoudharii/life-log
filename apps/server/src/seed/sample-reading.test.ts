import { countWords, lintCue, lintQuestion, parseQuestionContent, quoteInText } from '@life-log-club/domain'
import { describe, expect, it } from 'vitest'
import { SAMPLE } from './sample-reading'

// The sample's ideas and questions skip the AI and its checks, so they must pass the same checks here.
describe('the sample reading', () => {
	it('is about 1,100 words in 3 sections, with 3 key ideas each', () => {
		const words = SAMPLE.flatMap((s) => s.paragraphs).reduce((n, p) => n + countWords(p), 0)
		expect(words).toBeGreaterThan(1000)
		expect(words).toBeLessThan(1400)
		expect(SAMPLE.map((s) => s.ideas.length)).toEqual([3, 3, 3])
	})

	for (const [n, section] of SAMPLE.entries())
		for (const [k, idea] of section.ideas.entries())
			it(`section ${n + 1}, idea ${k + 1}: rests on a sentence of its section, with a cue and a question that pass the checks`, () => {
				const text = section.paragraphs.join('\n\n')
				expect(quoteInText(idea.quote, text)).toBe(true)
				expect(lintCue(idea.cue, idea.idea)).toEqual([])
				const { level, ...content } = idea.question
				expect(parseQuestionContent('short_answer', content)).not.toBeNull()
				expect(lintQuestion({ type: 'short_answer', level, content: { ...content, niceToHave: [] } } as never, text)).toEqual([])
			})
})
