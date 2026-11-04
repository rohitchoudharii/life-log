import { Readability } from '@mozilla/readability'
import { htmlToBlocks, type Block, type DomNode } from '@peak/core'
import { parseHTML } from 'linkedom'

export class ExtractError extends Error {}

/** Decodes a page with the charset its server or its own meta tag declares, UTF-8 otherwise. */
export function decodeHtml(body: Buffer, contentType: string): string {
	const declared =
		/charset=["']?([\w-]+)/i.exec(contentType)?.[1] ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(body.subarray(0, 4096).toString('latin1'))?.[1]
	try {
		return new TextDecoder(declared ?? 'utf-8').decode(body)
	} catch {
		return new TextDecoder('utf-8').decode(body)
	}
}

/**
 * Finds the article in a page with Mozilla Readability, as Firefox Reader View does, and turns it
 * into our blocks. The page's HTML is only parsed here, never stored or shown.
 */
export function extractArticle(html: string, url: string): { title: string; blocks: Block[] } {
	const { document } = parseHTML(html)
	// Headings wrapped with little else (Wikipedia's "[edit]" links, anchor links) look like
	// link-heavy boxes to Readability, which drops them and the page loses its sections.
	for (const h of document.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
		const wrapper = h.parentElement
		if (wrapper?.tagName === 'DIV' && (wrapper.textContent ?? '').length - (h.textContent ?? '').length < 30) wrapper.replaceWith(h)
	}
	const article = new Readability(document as unknown as Document, { charThreshold: 300, keepClasses: true }).parse()
	if (!article?.content) throw new ExtractError("Couldn't find an article on that page")
	const { document: doc } = parseHTML(`<!doctype html><html><body><div id="peak-article">${article.content}</div></body></html>`)
	const blocks = htmlToBlocks(doc.getElementById('peak-article') as unknown as DomNode, url)
	if (!blocks.some((b) => b.type !== 'image')) throw new ExtractError("Couldn't find any text on that page")
	const title = (article.title ?? '').replace(/\s+/g, ' ').trim() || new URL(url).hostname
	return { title: title.slice(0, 200), blocks }
}
