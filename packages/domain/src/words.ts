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
