/** What the popup learns from the tab before Save: how much text the page shows, and signs of a preview. */
export type PageSignals = {
	/** Words in the page's paragraphs, lists, quotes and code. */
	words: number
	/** A visible box asking the reader to subscribe or sign in, or one the page calls a paywall. */
	paywall: boolean
	/** How long the page says it is: its structured data's word count, or its "N min read". */
	expectedWords: number | null
}

export type PreviewWarning = { text: string; action: 'Save anyway' | 'Replace anyway' }

/** A page this much shorter than expected is probably a preview. */
const SHORT = 0.4
const format = (n: number) => n.toLocaleString('en-GB')

/**
 * Warns before saving a page that looks like a preview a site shows to people who are not signed
 * in: one that stops at a subscribe box, one much shorter than the copy already saved, or one much
 * shorter than the page says it is (or than the book's chapters usually are).
 */
export function previewWarning(page: PageSignals, saved: { words: number | null; bookWords: number | null }): PreviewWarning | null {
	if (page.paywall)
		return { text: 'This looks like a preview: the text stops at a subscribe box. Sign in to the site, reload the page, then save.', action: 'Save anyway' }
	if (saved.words && page.words < saved.words * SHORT)
		return {
			text: `This copy is much shorter than the one you saved (${format(page.words)} of ${format(saved.words)} words). Saving replaces it.`,
			action: 'Replace anyway',
		}
	const expected = page.expectedWords ?? saved.bookWords
	if (expected && expected >= 300 && page.words < expected * SHORT)
		return {
			text: `This page has much less text than expected (about ${format(page.words)} of ${format(expected)} words). It may be a preview.`,
			action: 'Save anyway',
		}
	return null
}
