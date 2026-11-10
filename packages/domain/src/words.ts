import { type Grade, gradeWritten, type Judge, type WrittenResponse } from './questions'

/** A word worth learning, as met in a reading: its dictionary form, the form in the text, that sentence, and its meaning there. */
export type Term = { word: string; form: string; sentence: string; meaning: string }

/** The longest word or term a member can add. */
export const MAX_WORD_CHARS = 60

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The word as it appears in the sentence: itself, or an inflection of it, so "saturate" finds
 * "saturating". Null when the sentence does not use it.
 */
export function formIn(sentence: string, word: string): string | null {
	const w = word.trim().toLowerCase()
	if (!w) return null
	const stem = w.replace(/(e|es|s|ed|ing|ly)$/, '')
	// The word itself first, then its stem; either way the whole word in the sentence is taken.
	for (const base of stem.length >= 4 && !w.includes(' ') ? [w, stem] : [w]) {
		const m = sentence.match(new RegExp(`(?<![\\p{L}])${escapeRegExp(base)}[\\p{L}]{0,4}(?![\\p{L}])`, 'iu'))
		if (m) return m[0]
	}
	return null
}

/**
 * A word's test at each level, easiest first: fill it back into its sentence, then say what it
 * means there, then use it in a sentence of one's own.
 */
export const WORD_TESTS = ['word_cloze', 'word_meaning', 'word_use'] as const
export type WordTest = (typeof WORD_TESTS)[number]

/**
 * The test for a word card at `level` (0 to 4, up one for each right answer, down one for each
 * wrong one): fill the blank at 0 and 1, so it takes two right answers to move on, the meaning at
 * 2, and using it from 3. A word with no sentence has no blank to fill, so it starts at the meaning.
 */
export function wordTestFor(level: number, hasSentence: boolean): WordTest {
	if (level >= 3) return 'word_use'
	if (level === 2 || !hasSentence) return 'word_meaning'
	return 'word_cloze'
}

export type WordContent = { word: string; form: string; sentence: string | null; meaning: string }

/** The sentence with the word's first appearance, as a whole word, blanked out. */
export function blankOut(c: Pick<WordContent, 'form' | 'sentence'>) {
	if (!c.sentence) return null
	return c.sentence.replace(new RegExp(`(?<![\\p{L}])${escapeRegExp(c.form)}(?![\\p{L}])`, 'iu'), '_____')
}

const bare = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

function editDistance(a: string, b: string) {
	const row = Array.from({ length: b.length + 1 }, (_, j) => j)
	for (let i = 1; i <= a.length; i++) {
		let prev = row[0]!
		row[0] = i
		for (let j = 1; j <= b.length; j++) {
			const next = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
			prev = row[j]!
			row[j] = next
		}
	}
	return row[b.length]!
}

/**
 * The missing word, in either form, ignoring case and punctuation, with one typo allowed in words
 * of 6 letters or more. Ported from the previous app.
 */
export function isSameWord(answer: string, c: Pick<WordContent, 'word' | 'form'>) {
	const a = bare(answer)
	return [c.form, c.word].some((w) => {
		const x = bare(w)
		return a === x || (x.length >= 6 && editDistance(a, x) <= 1)
	})
}

/** What a word test shows before the answer: the question, the sentence (blanked for the cloze), and a hint for the cloze. */
export function wordPrompt(test: WordTest, c: WordContent) {
	if (test === 'word_cloze') return { prompt: 'Which word fills the blank?', sentence: blankOut(c), hint: `Starts with “${c.form[0]}”, ${c.form.length} letters` }
	if (test === 'word_meaning') return { prompt: c.sentence ? `What does “${c.form}” mean here?` : `What does “${c.word}” mean?`, sentence: c.sentence, hint: null }
	return { prompt: `Use “${c.word}” in a sentence of your own, with the meaning it has here.`, sentence: c.sentence, hint: null }
}

/** What a graded word test shows: the word, and which test it was. The meaning is the reference. */
export type WordReveal = { word: string; test: WordTest }

/**
 * Grades a word test. The cloze is checked in code, with the right word shown beside the
 * learner's; the meaning and a sentence of one's own are judged, or checked by the learner
 * (`made`) without a key. The meaning in context is the reference every time.
 */
export async function gradeWord(test: WordTest, c: WordContent, r: WrittenResponse, judge: Judge): Promise<Grade> {
	const word: WordReveal = { word: c.word, test }
	if (test === 'word_cloze') {
		const given = 'skipped' in r ? null : r.answer
		const correct = given !== null && isSameWord(given, c)
		return { rating: correct ? 'good' : 'again', correct, reveal: { reference: c.meaning, word, exact: { kind: 'word', expected: c.form, given } } }
	}
	const inSentence = c.sentence ? ` in: ${c.sentence}` : ''
	const grade =
		test === 'word_meaning'
			? await gradeWritten({ prompt: `What does "${c.form}" mean${inSentence}`, reference: c.meaning, mustHave: [c.meaning], misconceptions: [] }, r, judge)
			: await gradeWritten(
					{
						prompt: `Use "${c.word}" in a new sentence, with the meaning it has${inSentence}`,
						reference: c.meaning,
						mustHave: [`Uses "${c.word}" (or a form of it) correctly, with the meaning: ${c.meaning}`, "Is a new sentence of the learner's own, not the one shown or a near copy of it"],
						misconceptions: [],
					},
					r,
					judge,
				)
	return { ...grade, reveal: { ...grade.reveal, word } }
}
