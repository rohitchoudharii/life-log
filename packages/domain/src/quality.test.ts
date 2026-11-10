import { describe, expect, it } from 'vitest'
import { isDuplicatePrompt, lintCue, lintQuestion, quoteInText } from './quality'

// Ported from the previous app (packages/core/src/core.test.ts at 4051df5^).
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
		expect(mcq(['Divide by √d_k', 'Multiply by d_k', 'Add d_k']).join()).toMatch(/exactly 4/)
	})

	it('rejects code in the prompt and code copied from the text, and output or numbers that give the answer away', () => {
		const code = 'for i in range(3):\n    total = total + i * i\nprint(total)'
		const withCode = `The text runs this loop.\n\n${code}`
		const po = (prompt: string, c: string, output = '5') => lintQuestion({ type: 'predict_output', level: 'apply', content: { prompt, code: c, output } }, withCode)
		expect(po('What does it print if total starts at 0?', code.replace('3', '4'))).toEqual([])
		expect(po('What does it print if total starts at 0?', code).join()).toMatch(/copies the text's own code/)
		expect(po('What does `print(total)` show?', code.replace('3', '4')).join()).toMatch(/backticks/)
		expect(po('What does it print if total starts at 0?', `${code.replace('3', '4')}  # 140`, '140').join()).toMatch(/gives the output away/)
		const wp = (prompt: string, answer: number, tolerance: number, steps = ['a', 'b']) =>
			lintQuestion({ type: 'worked_problem', level: 'apply', content: { prompt, answer, tolerance, steps } }, source)
		expect(wp('A key size of 64 gives what scale factor?', 0.125, 0.001)).toEqual([])
		expect(wp('What scale factor does a big key size give?', 0.125, 0.001).join()).toMatch(/its own numbers/)
		expect(wp('A key size of 64 gives what scale factor?', 0.125, 0).join()).toMatch(/tolerance for rounding/)
		expect(wp('A key size of 64 gives what scale factor?', 8, 0, ['a']).join()).toMatch(/2 key steps/)
		const fe = (prompt: string, code?: string) => lintQuestion({ type: 'find_error', level: 'analyze', content: { prompt, code, mustHave: ['x', 'y'] } }, source)
		expect(fe('What is wrong with this step?', 'scores = q @ k.T')).toEqual([])
		expect(fe('What is wrong with the scaling?').join()).toMatch(/flawed code/)
		expect(fe('What is wrong with the scaling?').join()).not.toMatch(/definition/)
	})

	it('rejects steps that give away their order, repeat, or are too few', () => {
		const steps = (s: string[]) => lintQuestion({ type: 'order_steps', level: 'explain', content: { prompt: 'Put the request in order.', steps: s } }, source)
		expect(steps(['DNS lookup', 'TCP handshake', 'TLS handshake', 'HTTP request'])).toEqual([])
		expect(steps(['First, DNS lookup', 'TCP handshake', 'TLS handshake', 'HTTP request']).join()).toMatch(/position/)
		expect(steps(['DNS lookup', 'TCP handshake', 'TCP handshake', 'HTTP request']).join()).toMatch(/repeated/)
		expect(steps(['DNS lookup', 'TCP handshake', 'HTTP request']).join()).toMatch(/4 to 7 steps/)
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
