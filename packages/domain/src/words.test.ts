import { describe, expect, it } from 'vitest'
import { blankOut, formIn, gradeWord, isSameWord, wordPrompt, wordTestFor } from './words'

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

// Ported from the previous app (packages/core/src/core.test.ts at 4051df5^, "word tests").
describe('word tests', () => {
	const w = { word: 'saturate', form: 'Saturating', sentence: 'Scaling keeps softmax from Saturating on large scores.', meaning: 'pushing almost all weight onto one option' }
	const noJudge = async () => {
		throw new Error('judge must not be called')
	}

	it('fills the blank at levels 0 and 1, says the meaning at 2, and uses the word from 3; without a sentence it starts at the meaning', () => {
		expect([0, 1, 2, 3, 4].map((l) => wordTestFor(l, true))).toEqual(['word_cloze', 'word_cloze', 'word_meaning', 'word_use', 'word_use'])
		expect([0, 1, 2, 3].map((l) => wordTestFor(l, false))).toEqual(['word_meaning', 'word_meaning', 'word_meaning', 'word_use'])
	})

	it('blanks the word where it appears and accepts it back in either form, with one typo in a long word', async () => {
		expect(wordPrompt('word_cloze', w)).toEqual({ prompt: 'Which word fills the blank?', sentence: 'Scaling keeps softmax from _____ on large scores.', hint: 'Starts with “S”, 10 letters' })
		for (const answer of ['saturating', 'Saturate.', 'saturatng']) expect((await gradeWord('word_cloze', w, { answer }, noJudge)).correct).toBe(true)
		for (const answer of ['saturated it', 'collapse']) expect((await gradeWord('word_cloze', w, { answer }, noJudge)).correct).toBe(false)
		expect(await gradeWord('word_cloze', w, { answer: 'collapse' }, noJudge)).toMatchObject({
			rating: 'again',
			reveal: { reference: w.meaning, word: { word: 'saturate', test: 'word_cloze' }, exact: { kind: 'word', expected: 'Saturating', given: 'collapse' } },
		})
		expect((await gradeWord('word_cloze', w, { skipped: true }, noJudge)).reveal.exact).toEqual({ kind: 'word', expected: 'Saturating', given: null })
		// A short word allows no typo: "cat" is not "car".
		expect(isSameWord('car', { word: 'cat', form: 'cat' })).toBe(false)
		// Only the whole word is blanked, not a word that contains it.
		expect(blankOut({ form: 'max', sentence: 'Softmax picks the max score.' })).toBe('Softmax picks the _____ score.')
	})

	it('grades meaning and use with the judge, against the meaning in context, and keeps the meaning as the reference', async () => {
		const seen: string[][] = []
		const judge = async (input: { mustHave: string[] }) => (seen.push(input.mustHave), { score: 4 as const, feedback: 'ok', points: input.mustHave.map(() => 'covered' as const) })
		expect(await gradeWord('word_meaning', w, { answer: 'all weight on one thing' }, judge)).toMatchObject({ correct: true, reveal: { reference: w.meaning, word: { test: 'word_meaning' } } })
		expect(await gradeWord('word_use', w, { answer: 'The flood saturated the field.' }, judge)).toMatchObject({ reveal: { reference: w.meaning, word: { test: 'word_use' } } })
		expect(seen[0]).toEqual([w.meaning])
		expect(seen[1]![0]).toMatch(/Uses "saturate".*pushing almost all weight/)
		// Without a key, the learner checks the meaning themselves.
		expect((await gradeWord('word_meaning', w, { answer: 'x', made: [false] }, noJudge)).correct).toBe(false)
	})
})
