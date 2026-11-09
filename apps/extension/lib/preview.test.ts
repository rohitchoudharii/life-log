import { describe, expect, it } from 'vitest'
import { previewWarning } from './preview'

const none = { words: null, bookWords: null }

describe('previewWarning', () => {
	it('warns about a subscribe box whatever the length', () => {
		expect(previewWarning({ words: 5000, paywall: true, expectedWords: null }, none)?.text).toMatch(/^This looks like a preview/)
	})

	it('warns when the page is under 40% of what it says it is, or of the book’s usual chapter', () => {
		expect(previewWarning({ words: 400, paywall: false, expectedWords: 1800 }, none)).toEqual({
			text: 'This page has much less text than expected (about 400 of 1,800 words). It may be a preview.',
			action: 'Save anyway',
		})
		// 720 words is 40% of 1,800: long enough.
		expect(previewWarning({ words: 720, paywall: false, expectedWords: 1800 }, none)).toBeNull()
		expect(previewWarning({ words: 100, paywall: false, expectedWords: null }, { words: null, bookWords: 3000 })?.text).toContain('about 100 of 3,000 words')
		// The page's own length wins over the book's.
		expect(previewWarning({ words: 500, paywall: false, expectedWords: 600 }, { words: null, bookWords: 3000 })).toBeNull()
	})

	it('asks before replacing a saved copy with a much shorter one', () => {
		expect(previewWarning({ words: 400, paywall: false, expectedWords: null }, { words: 3200, bookWords: null })).toEqual({
			text: 'This copy is much shorter than the one you saved (400 of 3,200 words). Saving replaces it.',
			action: 'Replace anyway',
		})
	})

	it('says nothing for a short page with nothing to compare it with', () => {
		expect(previewWarning({ words: 80, paywall: false, expectedWords: null }, none)).toBeNull()
		expect(previewWarning({ words: 80, paywall: false, expectedWords: 200 }, none)).toBeNull()
	})
})
