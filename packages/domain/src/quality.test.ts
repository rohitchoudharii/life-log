import { describe, expect, it } from 'vitest'
import { isDuplicatePrompt, lintCue, lintQuestion, quoteInText } from './quality'

// Ported from the previous app (packages/core/src/core.test.ts at 4051df5^), short answers only.
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

	it('treats reworded prompts with the same content words as duplicates, but not different questions', () => {
		expect(isDuplicatePrompt('Why does softmax saturate for large scores?', 'For large scores, why does softmax saturate?')).toBe(true)
		expect(isDuplicatePrompt('Why does softmax saturate for large scores?', 'How do multiple heads share the model dimension?')).toBe(false)
	})
})

describe('key idea checks', () => {
	const text = 'Recall after a gap is harder.  The effort of “pulling it back” is what makes a memory last, so cramming fades fast.'

	it('finds a quote in the text whatever its spacing, case and quote marks, but not a reworded one', () => {
		expect(quoteInText('the effort of "pulling it back" is what makes a memory last', text)).toBe(true)
		expect(quoteInText('“Recall after a gap is harder.”', text)).toBe(true)
		expect(quoteInText('The effort of recalling is what makes a memory last', text)).toBe(false)
		// Too short to show where the idea comes from.
		expect(quoteInText('cramming fades', text)).toBe(false)
	})

	it('wants a short question for a cue that does not give its idea away', () => {
		const idea = 'Effortful recall after a gap makes memories last longer than cramming.'
		expect(lintCue('Why does waiting before you test yourself help?', idea)).toEqual([])
		expect(lintCue('Effortful recall after a gap does what to memories?', idea).join()).toMatch(/gives the idea away/)
		expect(lintCue('Spacing', idea).join()).toMatch(/question/)
	})
})
