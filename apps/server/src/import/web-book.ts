import type { SectionKind } from '@life-log-club/domain'
import { parseHTML } from 'linkedom'
import { matterOf } from './matter'

/** The most pages Life Log Club adds from one web book; a longer book is refused, not cut. */
export const MAX_BOOK_PAGES = 200

/** One page of a web book, as its contents list names it. `level` 1 is a part or a top-level chapter. */
export type BookPage = { url: string; title: string; level: number; kind: SectionKind }

export type WebBook = {
	/** The book's contents page: the page itself, or the one a chapter page belongs to. */
	contentsUrl: string
	title: string
	pages: BookPage[]
	/** True when the page is the book's contents page; false when it is one of the book's chapters. */
	isContents: boolean
}

type Doc = ReturnType<typeof parseHTML>['document']
type El = ReturnType<Doc['createElement']>

const squash = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim()

/** Lists that book generators write for the whole book: mdBook, Sphinx's toctree, O'Reilly's HTMLBook. */
const GENERATED = ['ol.chapter', '.toctree-wrapper', 'nav[data-type="toc"]']
/** An id or class that names a list as the book's contents. */
const LABEL = /(^|[\s_-])(toc|contents|chapters|summary)([\s_-]|$)/i
const CONTENTS_HEADING = /^(table of )?contents$/i
/** Links in a contents list that are files to download, not pages of the book. */
const NOT_A_PAGE = /\.(pdf|epub|mobi|zip|png|jpe?g|gif|svg|webp|txt|md)$/i
const SEPARATOR = /\s+[|·•–—:-]\s+/
/** Links to the page before and after, which a chapter's own menu holds beside its subsections. */
const PAGER = '.prev-next, .nav-chapters, .mobile-nav-chapters, .pagination-nav, a[rel~="next"], a[rel~="prev"], a.prev, a.next'

/** The book's name: from the page's <title> without "Contents" or the site's name, else its heading, else the site. */
function bookTitle(document: Doc, url: string): string {
	const parts = squash(document.querySelector('title')?.textContent).split(SEPARATOR).filter(Boolean)
	const named = parts.find((p) => !CONTENTS_HEADING.test(p) && !/^(home|index)$/i.test(p))
	const h1 = squash(document.querySelector('h1')?.textContent)
	return (
		named ||
		(h1 && !CONTENTS_HEADING.test(h1) ? h1 : '') ||
		squash(document.querySelector('meta[property="og:site_name"]')?.getAttribute('content')) ||
		new URL(url).hostname
	).slice(0, 200)
}

const withoutHash = (href: string, base: string) => {
	try {
		const u = new URL(href, base)
		u.hash = ''
		return /^https?:$/.test(u.protocol) ? u.href : null
	} catch {
		return null
	}
}

/**
 * The book's pages in a contents list, in order: links to pages of the same site under the
 * list's own folder, each once (a link to a part of a page already listed is a subsection, not a
 * page), without the front and back matter that is not the book, and without the title page.
 */
function pagesIn(list: El, base: string, title: string): BookPage[] {
	const baseUrl = new URL(base)
	const folder = baseUrl.pathname.replace(/[^/]*$/, '')
	const seen = new Set<string>()
	const found: (BookPage & { depth: number })[] = []
	for (const a of Array.from(list.querySelectorAll('a[href]')) as El[]) {
		const url = withoutHash(a.getAttribute('href')!, base)
		if (!url || seen.has(url) || a.closest(PAGER)) continue
		seen.add(url)
		const u = new URL(url)
		if (u.origin !== baseUrl.origin || !u.pathname.startsWith(folder) || NOT_A_PAGE.test(u.pathname)) continue
		const name = squash(a.textContent)
		if (!name || name.toLowerCase() === title.toLowerCase()) continue
		const type = a.closest('[data-type]')?.getAttribute('data-type')
		const matter = matterOf({ types: type ? [type] : [], title: name })
		if (matter === 'drop') continue
		let depth = 0
		for (let el = a.parentElement; el && el !== list; el = el.parentElement) if (el.tagName === 'LI') depth++
		found.push({ url, title: name.slice(0, 300), level: 0, kind: matter === 'body' ? 'body' : 'reference', depth })
	}
	const top = Math.min(...found.map((p) => p.depth))
	return found.map(({ depth, ...p }) => ({ ...p, level: Math.min(3, depth - top + 1) }))
}

/**
 * A list a site labels as its contents counts only when it reads like a book's: it is numbered,
 * a "Contents" heading leads into it, or the page's link to the next page goes into it. A blog's
 * list of related posts is none of these.
 */
function confirmed(list: El, document: Doc, base: string, pages: BookPage[]) {
	// Mostly links, so not a whole page whose class names its table of contents (Wikipedia's <html>).
	const linkText = (Array.from(list.querySelectorAll('a')) as El[]).reduce((n, a) => n + squash(a.textContent).length, 0)
	if (linkText < squash(list.textContent).length / 2) return false
	if (list.tagName === 'OL' || list.querySelector('ol')) return true
	const before = list.previousElementSibling
	if (before && /^H[1-6]$/.test(before.tagName) && CONTENTS_HEADING.test(squash(before.textContent))) return true
	const next = document.querySelector('link[rel~="next"], a[rel~="next"], a.next')?.getAttribute('href')
	const nextUrl = next && withoutHash(next, base)
	return Boolean(nextUrl && pages.some((p) => p.url === nextUrl))
}

/** The contents lists in a page, with the address their links are relative to. */
function listsIn(document: Doc, base: string, title: string) {
	const lists: BookPage[][] = []
	for (const list of Array.from(document.querySelectorAll(GENERATED.join(', '))) as El[]) lists.push(pagesIn(list, base, title))
	for (const list of Array.from(document.querySelectorAll('[id], [class]')) as El[]) {
		if (!LABEL.test(`${list.getAttribute('id') ?? ''} ${list.getAttribute('class') ?? ''}`)) continue
		const pages = pagesIn(list, base, title)
		if (pages.length && confirmed(list, document, base, pages)) lists.push(pages)
	}
	for (const h of Array.from(document.querySelectorAll('h1, h2, h3')) as El[]) {
		const list = h.nextElementSibling
		if (CONTENTS_HEADING.test(squash(h.textContent)) && list && /^(OL|UL)$/.test(list.tagName)) lists.push(pagesIn(list, base, title))
	}
	return lists
}

/** Fetches a page's HTML, with the address it ended on after redirects. */
export type FetchPage = (url: string) => Promise<{ url: string; html: string }>

/** The book whose contents list a page holds, from the page or, for mdBook, from the toc.html its sidebar loads. */
async function contentsOf(document: Doc, url: string, fetchPage: FetchPage) {
	const title = bookTitle(document, url)
	const lists = listsIn(document, url, title)
	// mdBook 0.5 keeps the contents in toc.html, which every page loads into its sidebar.
	const toc = document.querySelector('iframe.sidebar-iframe-outer, iframe[src$="toc.html"]')?.getAttribute('src')
	const tocUrl = !lists.some((l) => l.length >= 3) && toc ? withoutHash(toc, url) : null
	if (tocUrl) {
		const page = await fetchPage(tocUrl).catch(() => null)
		if (page) lists.push(...listsIn(parseHTML(page.html).document, page.url, title))
	}
	const pages = lists.reduce<BookPage[]>((best, l) => (l.length > best.length ? l : best), [])
	return { title, pages: pages.length >= 3 ? pages : [], tocUrl }
}

/** Links from a chapter page up towards its book: Up, Contents, the cover (Eloquent JavaScript), Sphinx's accesskey U. */
const UP = 'link[rel~="up"], link[rel~="contents"], link[rel~="toc"], a[rel~="up"], a[rel~="contents"], a[accesskey="U"], a[accesskey="u"]'
const UP_NAME = /^(up|contents|table of contents|toc|cover)$/i

function upLinks(document: Doc, url: string): string[] {
	const named = (Array.from(document.querySelectorAll('a[href]')) as El[]).filter((a) =>
		[a.textContent, a.getAttribute('title'), a.getAttribute('aria-label')].some((name) => UP_NAME.test(squash(name?.replace(/[^\p{L}\s]/gu, '')))),
	)
	const origin = new URL(url).origin
	const urls = [...(Array.from(document.querySelectorAll(UP)) as El[]), ...named].flatMap((el) => withoutHash(el.getAttribute('href') ?? '', url) ?? [])
	return [...new Set(urls.filter((u) => new URL(u).origin === origin))]
}

/** Up links followed from a chapter page, and contents pages fetched on each hop, at most. */
const HOPS = 2
const PER_HOP = 3

/**
 * Finds the book a web page belongs to: a book whose chapters are each their own page, such as
 * one written with mdBook (The Rust Programming Language), Sphinx (the Python tutorial), O'Reilly's
 * HTMLBook, or by hand (Crafting Interpreters, Eloquent JavaScript). A list of at least three
 * pages is needed. On a contents page, reads its list. On a chapter page, finds the contents page
 * that lists it: the folder mdBook's toc.html is in, or the page its Up or Contents link leads
 * to, two links up at most, and the largest such book (Crafting Interpreters goes from a chapter
 * to its part, which lists the part's chapters, then to the contents). Returns null for a page
 * that is no part of a book.
 */
export async function findBook(html: string, url: string, fetchPage: FetchPage): Promise<WebBook | null> {
	const fetched = new Map<string, ReturnType<FetchPage>>()
	const fetchOnce: FetchPage = (u) => {
		if (!fetched.has(u)) fetched.set(u, fetchPage(u))
		return fetched.get(u)!
	}
	const self = withoutHash(url, url)!
	const lists = (pages: BookPage[], u: string) => pages.length > 0 && !pages.some((p) => p.url === u)
	const { document } = parseHTML(html)
	const here = await contentsOf(document, url, fetchOnce)
	if (lists(here.pages, self)) return { contentsUrl: self, title: here.title, pages: here.pages, isContents: true }

	let candidates = [...(here.tocUrl && here.pages.length ? [new URL('./', here.tocUrl).href] : []), ...upLinks(document, url)]
	const tried = new Set([self])
	// A part's own list of its chapters (Crafting Interpreters) is a book too; the largest one wins.
	let found: WebBook | null = null
	for (let hop = 0; hop < HOPS && candidates.length; hop++) {
		const next: string[] = []
		for (const candidate of candidates.filter((c) => !tried.has(c)).slice(0, PER_HOP)) {
			tried.add(candidate)
			const page = await fetchOnce(candidate).catch(() => null)
			if (!page) continue
			const doc = parseHTML(page.html).document
			const there = await contentsOf(doc, page.url, fetchOnce)
			const contentsUrl = withoutHash(page.url, page.url)!
			if (lists(there.pages, contentsUrl) && there.pages.some((p) => p.url === self) && there.pages.length > (found?.pages.length ?? 0))
				found = { contentsUrl, title: there.title, pages: there.pages, isContents: false }
			next.push(...upLinks(doc, page.url))
		}
		candidates = next
	}
	return found
}
