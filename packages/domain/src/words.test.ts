import { describe, expect, it } from 'vitest'
import { formIn } from './words'

describe('formIn', () => {
	it('finds the word as the sentence uses it: itself, an inflection, or a term, whole words only', () => {
		const sentence = 'Scaling keeps softmax from Saturating on large scores.'
		expect(formIn(sentence, 'saturate')).toBe('Saturating')
		expect(formIn(sentence, 'Saturating')).toBe('Saturating')
		expect(formIn(sentence, 'large scores')).toBe('large scores')
		// "max" is inside "softmax", not a word of the sentence.
		expect(formIn(sentence, 'max')).toBeNull()
		expect(formIn(sentence, 'gradient')).toBeNull()
		expect(formIn(sentence, ' ')).toBeNull()
	})
})
