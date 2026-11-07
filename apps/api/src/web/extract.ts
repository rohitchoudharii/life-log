import { Readability } from '@mozilla/readability'
import { htmlToBlocks, type Block, type DomNode } from '@life-log-club/core'
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

const VIDEO_HOSTS = /(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be|vimeo\.com|loom\.com|wistia\.(com|net))$/i
type Doc = ReturnType<typeof parseHTML>['document']
type El = ReturnType<Doc['createElement']>

const squash = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim()

/**
 * Puts a page's media in the shape the reader keeps: images as plain <img>, figure captions as
 * text, and videos (which Life Log Club does not store) as their poster image and a line saying where to
 * watch them. Runs before Readability, which would otherwise drop the embeds.
 */
function normaliseMedia(document: Doc, url: string) {
	const abs = (v: string | null | undefined) => {
		try {
			return v ? new URL(v, url).href : null
		} catch {
			return null
		}
	}
	const all = (selector: string) => Array.from(document.querySelectorAll(selector)) as El[]
	const note = (title: string, href: string | null, poster: string | null) => {
		const p = document.createElement('p')
		if (poster) {
			const img = document.createElement('img')
			img.setAttribute('src', poster)
			img.setAttribute('alt', title ? `Video: ${title}` : 'Video')
			p.append(img)
		}
		p.append(`Video${title ? `: ${title}` : ''}. Watch it on the original page${href ? ` (${href})` : ''}.`)
		return p
	}
	// <picture> picks one of several sources; keep its <img>, with a source's srcset if it has no src.
	for (const pic of all('picture')) {
		const img = pic.querySelector('img')
		const set = pic.querySelector('source[srcset]')?.getAttribute('srcset')
		if (img && !img.getAttribute('src') && set) img.setAttribute('srcset', set)
		if (img) pic.replaceWith(img)
		else pic.remove()
	}
	for (const v of all('video')) {
		const src = abs(v.getAttribute('src') ?? v.querySelector('source')?.getAttribute('src'))
		v.replaceWith(note(squash(v.getAttribute('title') ?? v.getAttribute('aria-label')), src?.startsWith('http') ? src : null, abs(v.getAttribute('poster'))))
	}
	for (const f of all('iframe')) {
		const src = abs(f.getAttribute('src') ?? f.getAttribute('data-src'))
		if (!src || !VIDEO_HOSTS.test(new URL(src).hostname)) continue
		const id = /youtube(?:-nocookie)?\.com\/embed\/([\w-]{6,})/.exec(src)?.[1]
		f.replaceWith(note(squash(f.getAttribute('title')), id ? `https://www.youtube.com/watch?v=${id}` : src, id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null))
	}
	// A caption written as a heading (O'Reilly uses <h6>) would start a new section; it is text.
	const levels = [1, 2, 3, 4, 5, 6]
	for (const h of all(levels.flatMap((n) => [`figure h${n}`, `.figure h${n}`]).join(', '))) {
		const p = document.createElement('p')
		p.append(...Array.from(h.childNodes))
		h.replaceWith(p)
	}
	// Readability marks boxes whose class says "media", "share" or similar as clutter. A small box
	// around an image is a figure, so its class and id are dropped before it is scored.
	for (const img of all('img')) {
		for (let box = img.parentElement, depth = 0; box && box.tagName !== 'BODY' && depth < 3; box = box.parentElement, depth++) {
			if (squash(box.textContent).length > 400) break
			box.removeAttribute('class')
			box.removeAttribute('id')
		}
	}
}

/**
 * Finds the article in a page with Mozilla Readability, as Firefox Reader View does, and turns it
 * into our blocks. The page's HTML is only parsed here, never stored or shown.
 */
export function extractArticle(html: string, url: string): { title: string; blocks: Block[] } {
	const { document } = parseHTML(html)
	normaliseMedia(document, url)
	// Headings wrapped with little else (Wikipedia's "[edit]" links, anchor links) look like
	// link-heavy boxes to Readability, which drops them and the page loses its sections.
	for (const h of document.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
		const wrapper = h.parentElement
		// A wrapper holding media (a figure with its caption) is content, not a heading box.
		const holdsMedia = wrapper?.querySelector('img, picture, video, iframe, svg, table, pre')
		if (wrapper?.tagName === 'DIV' && !holdsMedia && (wrapper.textContent ?? '').length - (h.textContent ?? '').length < 30) wrapper.replaceWith(h)
	}
	// Some sites (GeeksforGeeks) hide the whole page with visibility:hidden until their scripts run.
	// Readability skips hidden elements, so a box holding most of the page's text is shown again.
	// Scripts go first (Readability drops them anyway): their JSON can outweigh the page's text.
	for (const s of Array.from(document.querySelectorAll('script, style')) as El[]) s.remove()
	const pageText = (document.body?.textContent ?? '').length
	for (const el of Array.from(document.querySelectorAll('[style*="visibility"]')) as El[])
		if (/visibility\s*:\s*hidden/i.test(el.getAttribute('style') ?? '') && (el.textContent ?? '').length > pageText / 2)
			el.setAttribute('style', (el.getAttribute('style') ?? '').replace(/visibility\s*:\s*hidden\s*;?/gi, ''))
	const article = new Readability(document as unknown as Document, { charThreshold: 300, keepClasses: true }).parse()
	if (!article?.content) throw new ExtractError("Couldn't find an article on that page")
	const { document: doc } = parseHTML(`<!doctype html><html><body><div id="life-log-club-article">${article.content}</div></body></html>`)
	const blocks = htmlToBlocks(doc.getElementById('life-log-club-article') as unknown as DomNode, url)
	if (!blocks.some((b) => b.type !== 'image')) throw new ExtractError("Couldn't find any text on that page")
	const title = (article.title ?? '').replace(/\s+/g, ' ').trim() || new URL(url).hostname
	return { title: title.slice(0, 200), blocks }
}
