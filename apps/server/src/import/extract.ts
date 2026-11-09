import { type Block, blockText, countWords } from '@life-log-club/domain'
import { Readability } from '@mozilla/readability'
import { parseHTML } from 'linkedom'
import { type DomNode, htmlToBlocks } from './html'

/** A page that has no article we can keep, with a message for the member. */
export class ExtractError extends Error {}

export const SIGN_IN = 'This page needs you to be signed in. The Chrome extension will capture it later.'

/** A byte-order mark names the encoding for certain, ahead of anything the page declares. */
function bomCharset(body: Buffer) {
	if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) return 'utf-8'
	if (body[0] === 0xff && body[1] === 0xfe) return 'utf-16le'
	if (body[0] === 0xfe && body[1] === 0xff) return 'utf-16be'
	return undefined
}

/** Decodes a page with its byte-order mark, the charset its server or its own meta tag declares, or UTF-8. */
export function decodeHtml(body: Buffer, contentType: string): string {
	const declared =
		bomCharset(body) ??
		/charset=["']?([\w-]+)/i.exec(contentType)?.[1] ??
		/<meta[^>]+charset=["']?([\w-]+)/i.exec(body.subarray(0, 4096).toString('latin1'))?.[1]
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

const squashLower = (s: string | null | undefined) => squash(s).toLowerCase()

/**
 * A site's furniture around the text, which Readability can mistake for part of it: book sites'
 * help popups and menus (mdBook), the links to the chapter before and after (mdBook, Crafting
 * Interpreters, Docusaurus), "Edit this page", and the "¶" link beside each heading (Sphinx).
 */
const FURNITURE = [
	'#mdbook-help-container',
	'#mdbook-menu-bar',
	'#mdbook-search-wrapper',
	'.nav-chapters',
	'.mobile-nav-chapters',
	'.prev-next',
	'footer a.next',
	'.pagination-nav',
	'.theme-edit-this-page',
	'a.headerlink',
	'a[rel~="next"]',
	'a[rel~="prev"]',
].join(', ')
const bareHost = (u: URL) => u.hostname.replace(/^www\./, '')

/** The page's own canonical address, when it names one on the same site. Another site's is ignored. */
function canonicalUrl(document: Doc, url: string): string | null {
	const declared =
		document.querySelector('link[rel~="canonical"]')?.getAttribute('href') ?? document.querySelector('meta[property="og:url"]')?.getAttribute('content')
	if (!declared) return null
	try {
		const canonical = new URL(declared, url)
		canonical.hash = ''
		return /^https?:$/.test(canonical.protocol) && bareHost(canonical) === bareHost(new URL(url)) ? canonical.href : null
	} catch {
		return null
	}
}

/** True when the page's structured data says the full text is for subscribers only. */
function markedPaid(document: Doc): boolean {
	return (Array.from(document.querySelectorAll('script[type="application/ld+json"]')) as El[]).some((s) =>
		/"isAccessibleForFree"\s*:\s*(false|"false")/i.test(s.textContent ?? ''),
	)
}

export type Article = {
	title: string
	author: string | null
	publishedAt: Date | null
	canonicalUrl: string | null
	blocks: Block[]
}

/**
 * Finds the article in a page with Mozilla Readability, as Firefox Reader View does, and turns it
 * into our blocks, with its title, author, published date and canonical address. The page's HTML
 * is only parsed here, never stored or shown. A sign-in form with little else, or a short text the
 * page marks as for subscribers, is refused as a page behind a sign-in.
 */
export function extractArticle(html: string, url: string): Article {
	const { document } = parseHTML(html)
	// A page that leaves out its <html>, <head> and <body> tags (Eloquent JavaScript) has its text
	// outside the empty body in linkedom, where Readability never looks.
	if (document.body && !squash(document.body.textContent))
		for (const el of Array.from(document.children) as El[]) if (el !== document.documentElement) document.body.append(el)
	const canonical = canonicalUrl(document, url)
	const paid = markedPaid(document)
	const signInForm = Boolean(document.querySelector('input[type="password"]'))
	for (const el of Array.from(document.querySelectorAll(FURNITURE)) as El[]) el.remove()
	// Readability reads the title from <head>, which a page without one (Eloquent JavaScript) lacks.
	const pageTitle = squash(document.querySelector('title')?.textContent)
	const h1s = document.querySelectorAll('h1')
	const h1 = h1s.length === 1 ? squash(h1s[0]!.textContent) : ''
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
	// Structured data stays: Readability reads the author and date from it.
	for (const s of Array.from(document.querySelectorAll('script:not([type="application/ld+json"]), style')) as El[]) s.remove()
	const pageText = (document.body?.textContent ?? '').length
	for (const el of Array.from(document.querySelectorAll('[style*="visibility"]')) as El[])
		if (/visibility\s*:\s*hidden/i.test(el.getAttribute('style') ?? '') && (el.textContent ?? '').length > pageText / 2)
			el.setAttribute('style', (el.getAttribute('style') ?? '').replace(/visibility\s*:\s*hidden\s*;?/gi, ''))
	const pageWords = countWords(document.body?.textContent ?? '')
	const article = new Readability(document as unknown as ConstructorParameters<typeof Readability>[0], { charThreshold: 300, keepClasses: true }).parse()
	if (signInForm && pageWords < 200) throw new ExtractError(SIGN_IN)
	if (!article?.content) throw new ExtractError("We couldn't find an article on this page.")
	const { document: doc } = parseHTML(`<!doctype html><html><body><div id="life-log-club-article">${article.content}</div></body></html>`)
	const blocks = htmlToBlocks(doc.getElementById('life-log-club-article') as unknown as DomNode, url)
	// A title like "Execution model - JavaScript | MDN" adds the site's name to the page's own heading.
	const found = squash(article.title) || pageTitle
	// A chapter number set above the chapter's heading (Crafting Interpreters' "4") is no paragraph.
	while (blocks[0]?.type === 'paragraph' && /^(\d{1,3}|[IVXLC]{1,7})\.?$/.test(blocks[0].text)) blocks.shift()
	// The same, when the page's heading is not an <h1> (mdBook): its first heading and then a separator.
	const lead = blocks[0]?.type === 'heading' ? blocks[0].text : ''
	const named = [h1, lead].find((h) => h.length >= 3 && squashLower(found).startsWith(squashLower(h)) && /^(\s*[-|:·–—]|$)/.test(found.slice(h.length)))
	const title = named || found || new URL(url).hostname
	// The page's title repeated as its first heading would make an empty first section.
	const first = blocks[0]
	if (first?.type === 'heading' && squashLower(first.text) === squashLower(title)) blocks.shift()
	const words = blocks.reduce((n, b) => n + countWords(blockText(b)), 0)
	if (!words) throw new ExtractError("We couldn't find an article on this page.")
	if (paid && words < 600) throw new ExtractError(SIGN_IN)
	const published = article.publishedTime ? new Date(article.publishedTime) : null
	return {
		title: title.slice(0, 200),
		author: squash(article.byline).slice(0, 200) || null,
		publishedAt: published && !Number.isNaN(published.getTime()) ? published : null,
		canonicalUrl: canonical,
		blocks,
	}
}
