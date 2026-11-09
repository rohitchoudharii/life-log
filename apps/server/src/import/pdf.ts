import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { type Block, type Chapter, countWords } from '@life-log-club/domain'
import { ExtractError } from './extract'
import { matterOf } from './matter'

/** A run of text on a page, with its position in PDF units (origin at the bottom left). */
export type PdfItem = { str: string; x: number; y: number; size: number; width: number }
export type PdfPage = { number: number; width: number; height: number; items: PdfItem[] }

type Line = { text: string; x: number; right: number; y: number; size: number; page: number }

const round = (n: number) => Math.round(n * 2) / 2
const words = countWords

/** Joins a page's text runs into lines, top to bottom and left to right. */
function linesOf(page: PdfPage): Line[] {
	const items = page.items.filter((i) => i.str.trim()).map((i) => ({ ...i }))
	// A note marker is set small and raised above the line it belongs to; read on its own, it
	// would start a line ("1 But there is…") that looks like a numbered heading.
	for (const it of items) {
		if (!/^[\d*†‡]{1,3}$/.test(it.str.trim())) continue
		const hosts = items.filter((o) => o.size > it.size * 1.25 && it.y > o.y && it.y - o.y < o.size * 0.6)
		const host = hosts.sort((a, b) => Math.abs(a.x - it.x) - Math.abs(b.x - it.x))[0]
		if (host) it.y = host.y
	}
	// Runs on one line can differ in height by a rounding error, so they are grouped into rows
	// first and each row is read left to right.
	items.sort((a, b) => b.y - a.y)
	const rows: (typeof items)[] = []
	for (const it of items) {
		const row = rows.at(-1)
		if (row && Math.abs(row[0]!.y - it.y) < it.size * 0.25) row.push(it)
		else rows.push([it])
	}
	const lines: Line[] = []
	for (const it of rows.flatMap((r) => r.sort((a, b) => a.x - b.x))) {
		const line = [...lines].reverse().find((l) => Math.abs(l.y - it.y) < Math.max(l.size, it.size) * 0.5 && it.x >= l.x - 1)
		// Words are well under a character apart; a gap wider than that is a column gutter, except
		// after a section number ("3.1   Attention"), which is set apart from its heading.
		const reach = line && /^\d{1,2}(\.\d{1,2})*\.?$/.test(line.text.trim()) ? it.size * 4 : it.size
		if (line && it.x - line.right < reach && it.x > line.right - it.size) {
			const gap = it.x - line.right
			line.text += (gap > it.size * 0.15 && !line.text.endsWith(' ') && !it.str.startsWith(' ') ? ' ' : '') + it.str
			line.right = Math.max(line.right, it.x + it.width)
			line.size = Math.max(line.size, it.size)
		} else lines.push({ text: it.str, x: it.x, right: it.x + it.width, y: it.y, size: it.size, page: page.number })
	}
	for (const l of lines) l.text = l.text.replace(/\s+/g, ' ').trim()
	// Lines without a letter are figure axes, table numbers, or stray symbols.
	return lines.filter((l) => /\p{L}/u.test(l.text)).sort((a, b) => b.y - a.y || a.x - b.x)
}

/**
 * Two-column pages are read down the left column, then the right. Lines that span both columns
 * (a title, an abstract heading) keep their place above or below the columns.
 */
function readingOrder(lines: Line[], width: number, body: number): Line[] {
	const mid = width / 2
	const narrowLeft = lines.filter((l) => l.right <= mid + width * 0.03)
	const narrowRight = lines.filter((l) => l.x >= mid - width * 0.03)
	if (narrowLeft.length < 5 || narrowRight.length < 5 || (narrowLeft.length + narrowRight.length) / lines.length < 0.6) return lines
	// The columns start at their first line of body text; the title and authors above them, set
	// larger and often spread across the page, are read first.
	const top = Math.max(...[...narrowLeft, ...narrowRight].filter((l) => Math.abs(round(l.size) - body) <= 0.5).map((l) => l.y))
	const inColumns = (l: Line) => l.y <= top + body * 0.5
	const left = narrowLeft.filter(inColumns)
	const right = narrowRight.filter(inColumns)
	const columns = new Set([...left, ...right])
	// Body text running across the middle between the column lines means one column, with short
	// lines (headings, figure labels) on both sides.
	const bottom = Math.min(...[...columns].map((l) => l.y))
	const across = lines.filter((l) => !columns.has(l) && l.y <= top && l.y >= bottom && Math.abs(round(l.size) - body) <= 0.5)
	if (across.length >= 3) return lines
	const above = lines.filter((l) => !columns.has(l) && l.y > top)
	const below = lines.filter((l) => !columns.has(l) && l.y <= top)
	return [...above, ...left, ...right, ...below]
}

/** Header and footer lines: in the top or bottom margin, and repeated on many pages (page numbers vary, so digits are ignored). */
function repeatedMargins(pages: PdfPage[], lines: Line[][]): Set<Line> {
	const key = (l: Line) => l.text.toLowerCase().replace(/\d+/g, '#')
	const inMargin = (l: Line, p: PdfPage) => l.y > p.height * 0.92 || l.y < p.height * 0.08
	const counts = new Map<string, number>()
	lines.forEach((ls, i) => new Set(ls.filter((l) => inMargin(l, pages[i]!)).map(key)).forEach((k) => counts.set(k, (counts.get(k) ?? 0) + 1)))
	const limit = Math.max(2, Math.ceil(pages.length * 0.4))
	const out = new Set<Line>()
	lines.forEach((ls, i) =>
		ls.forEach((l) => {
			if (!inMargin(l, pages[i]!)) return
			if ((counts.get(key(l)) ?? 0) >= limit || /^(page\s*)?\d{1,4}(\s*(of|\/)\s*\d+)?$/i.test(l.text)) out.add(l)
		}),
	)
	return out
}

const NUMBERED = /^(\d{1,2}(?:\.\d{1,2}){0,2})\.?\s+\p{Lu}/u
/** A line of a table of contents: its title, dot leaders, and a page number. */
const LEADER = /(\.\s?){3,}\s*[\divxlc]+$/i

/** A block, with the page and height (PDF units from the bottom) its first line starts at. */
type Placed = { block: Block; page: number; y: number }

/** Turns positioned text into blocks, keeping where each starts. See layoutPdf. */
function layout(pages: PdfPage[]): Placed[] {
	const perPage = pages.map(linesOf)
	const drop = repeatedMargins(pages, perPage)
	// A table of contents page is the book's own index of itself, not text to read.
	const isContents = (ls: Line[]) => {
		const n = ls.filter((l) => LEADER.test(l.text)).length
		return n >= 3 && n >= ls.length * 0.3
	}
	const kept = perPage.map((ls) => (isContents(ls) ? [] : ls.filter((l) => !drop.has(l))))
	// The body size is the one most text is set in.
	const weight = new Map<number, number>()
	for (const l of kept.flat()) weight.set(round(l.size), (weight.get(round(l.size)) ?? 0) + l.text.length)
	const body = [...weight].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 10
	const ordered = kept.map((ls, i) => readingOrder(ls, pages[i]!.width, body))
	const letters = (s: string) => (s.match(/\p{L}/gu)?.length ?? 0) / s.replace(/\s/g, '').length
	// Formulas are often set large too, so a heading must read like words. A numbered line set
	// smaller than the body is a footnote ("1 But there is little reason…"), not a heading.
	const looksLikeHeading = (l: Line) =>
		l.text.length <= 120 &&
		/^[\p{Lu}\d]/u.test(l.text) &&
		letters(l.text) >= 0.6 &&
		!/[.,;:]$/.test(l.text) &&
		(round(l.size) >= body * 1.15 || (NUMBERED.test(l.text) && words(l.text) <= 12 && round(l.size) >= body - 0.5))
	// The same large line near the top of three or more pages is a running title (each opinion
	// in a court ruling opens with the court's name), not a heading.
	const opening = new Map<string, number>()
	kept.forEach((ls, i) => {
		for (const l of ls) if (l.y > pages[i]!.height * 0.66 && looksLikeHeading(l)) opening.set(l.text.toLowerCase(), (opening.get(l.text.toLowerCase()) ?? 0) + 1)
	})
	const isHeading = (l: Line) => looksLikeHeading(l) && (opening.get(l.text.toLowerCase()) ?? 0) < 3
	const depth = (l: Line) => NUMBERED.exec(l.text)?.[1]!.split('.').length
	// Numbered headings nest by their numbering; others take the level of numbered ones their size.
	const sizeLevel = new Map<number, number>()
	for (const l of ordered.flat()) if (isHeading(l) && depth(l)) sizeLevel.set(round(l.size), Math.min(sizeLevel.get(round(l.size)) ?? 9, depth(l)!))
	const headingSizes = [...new Set(ordered.flat().filter((l) => isHeading(l) && round(l.size) >= body * 1.15).map((l) => round(l.size)))].sort((a, b) => b - a)
	const levelOf = (l: Line) => {
		const d = depth(l) ?? sizeLevel.get(round(l.size))
		if (d) return Math.min(3, d)
		if (sizeLevel.size) return round(l.size) > Math.max(...sizeLevel.keys()) ? 1 : 2
		return Math.min(3, headingSizes.indexOf(round(l.size)) + 1)
	}

	const out: Placed[] = []
	let para: Line[] = []
	const flush = () => {
		if (!para.length) return
		let text = ''
		for (const l of para) text = /\p{L}-$/u.test(text) && /^\p{Ll}/u.test(l.text) ? text.slice(0, -1) + l.text : text ? `${text} ${l.text}` : l.text
		out.push({ block: { type: 'paragraph', text }, page: para[0]!.page, y: para[0]!.y })
		para = []
	}
	ordered.forEach((lines, i) => {
		flush()
		out.push({ block: { type: 'page', number: pages[i]!.number }, page: pages[i]!.number, y: Number.POSITIVE_INFINITY })
		lines.forEach((l, k) => {
			if (isHeading(l)) {
				flush()
				const last = out.at(-1)
				// A heading set on two lines arrives as two lines of the same size; much longer is a
				// passage set large (a notice on the title page), which reads as a paragraph.
				if (last?.block.type === 'heading' && k > 0 && Math.abs(lines[k - 1]!.size - l.size) < 0.5 && isHeading(lines[k - 1]!)) {
					if (last.block.text.length + l.text.length < 150) last.block.text += ` ${l.text}`
					else last.block = { type: 'paragraph', text: `${last.block.text} ${l.text}` }
				} else out.push({ block: { type: 'heading', level: levelOf(l), text: l.text }, page: l.page, y: l.y })
				return
			}
			const prev = para.at(-1)
			const gap = prev ? prev.y - l.y : 0
			// A new paragraph after a blank gap, or at an indented first line.
			if (prev && (gap > prev.size * 1.8 || gap < 0 || l.x - prev.x > l.size * 1.2)) flush()
			para.push(l)
		})
	})
	flush()
	return out
}

/**
 * Turns a PDF's positioned text into blocks. Headings are lines set larger than the body text, or
 * short numbered lines like "3.1 Encoder", nested by size or numbering depth. Paragraphs are
 * joined across lines, with words broken by a hyphen at a line end put back together. Table of
 * contents pages are left out.
 */
export const layoutPdf = (pages: PdfPage[]): Block[] => layout(pages).map((p) => p.block)

/** An entry of a PDF's outline (its bookmarks): a chapter's title, depth, page, and the height it starts at when the PDF says. */
export type OutlineEntry = { title: string; level: number; page: number; y: number | null }

const plain = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const unnumbered = (s: string) => plain(s.replace(/^(\d+(\.\d+)*|\p{Lu}(\.\d+)*)\.?\s+/u, ''))
/** True when a heading found in the text is the outline's entry, with or without its number ("3.1 Motivation"). */
const sameTitle = (heading: string, entry: string) =>
	plain(heading) === plain(entry) || unnumbered(heading) === plain(entry) || plain(heading) === unnumbered(entry)

/**
 * Splits a PDF into chapters. When it has an outline (bookmarks) that goes forward through the
 * pages, each entry starts a chapter at its depth, at the heading that repeats its title, or else
 * where the outline points; the headings found by size nest inside. Without one, each top-level
 * heading starts a chapter. A heading such as "References" or "Index" always starts a chapter of
 * its own, so it can be kept as a reference or left out (see matterOf). Text before the first
 * chapter (a paper's title and abstract) is a chapter titled `title`.
 *
 * `article` is true for a PDF with no outline and no headings at all: it is split like an article.
 */
export function pdfChapters(pages: PdfPage[], outline: OutlineEntry[], title: string): { chapters: Chapter[]; article: boolean } {
	const placed = layout(pages)
	const starts: { at: number; title: string; level: number }[] = []
	// Headings that only repeat a chapter's title, which the chapter's section already shows.
	const repeated = new Set<number>()
	const startAt = (at: number, entry: { title: string; level: number }) => {
		// The page marker right before a chapter belongs to it.
		const pageStart = at > 0 && placed[at - 1]!.block.type === 'page' && placed[at - 1]!.page === placed[at]?.page
		starts.push({ at: pageStart ? at - 1 : at, ...entry })
	}
	const usable = outline.length >= 2 && outline.every((e, i) => i === 0 || e.page >= outline[i - 1]!.page)
	if (usable) {
		let cursor = 0
		for (const entry of outline) {
			let at = -1
			for (let i = cursor; i < placed.length && placed[i]!.page <= entry.page + 1; i++) {
				const b = placed[i]!.block
				if (b.type === 'heading' && placed[i]!.page >= entry.page && sameTitle(b.text, entry.title)) {
					at = i
					break
				}
			}
			if (at >= 0) repeated.add(at)
			else {
				at = placed.findIndex(
					(p, i) => i >= cursor && (p.page > entry.page || (p.page === entry.page && p.block.type !== 'page' && (entry.y === null || p.y <= entry.y + 2))),
				)
				if (at < 0) at = placed.length
			}
			startAt(at, entry)
			cursor = at
		}
	} else {
		const top = Math.min(...placed.flatMap((p) => (p.block.type === 'heading' ? [p.block.level] : [])))
		placed.forEach((p, i) => {
			if (p.block.type !== 'heading' || p.block.level !== top) return
			repeated.add(i)
			startAt(i, { title: p.block.text, level: 1 })
		})
	}
	placed.forEach((p, i) => {
		if (p.block.type !== 'heading' || repeated.has(i) || matterOf({ title: p.block.text }) === 'body') return
		repeated.add(i)
		startAt(i, { title: p.block.text, level: 1 })
	})
	starts.sort((a, b) => a.at - b.at)

	const blocksIn = (from: number, to: number) => placed.slice(from, to).flatMap((p, k) => (repeated.has(from + k) ? [] : [p.block]))
	const chapters: Chapter[] = []
	const first = starts[0]?.at ?? placed.length
	if (first > 0) chapters.push({ title, level: 1, kind: 'body', blocks: blocksIn(0, first) })
	starts.forEach((s, k) => {
		const matter = matterOf({ title: s.title })
		if (matter === 'drop' || matter === 'notes') return
		chapters.push({ title: s.title, level: s.level, kind: matter === 'reference' ? 'reference' : 'body', blocks: blocksIn(s.at, starts[k + 1]?.at ?? placed.length) })
	})
	return { chapters, article: !starts.length }
}

/** The largest text on the first page, joined across its lines. */
function titleOf(page: PdfPage | undefined): string {
	if (!page) return ''
	const lines = linesOf(page)
	const top = Math.max(0, ...lines.map((l) => l.size))
	const text = lines.filter((l) => l.size >= top - 0.5).map((l) => l.text).join(' ')
	return words(text) <= 25 ? text : ''
}

const require = createRequire(import.meta.url)
const FONTS = pathToFileURL(join(dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts') + '/').href

export type Pdf = { title: string; author: string | null; chapters: Chapter[]; article: boolean }

type PdfDocument = Awaited<ReturnType<(typeof import('pdfjs-dist/legacy/build/pdf.mjs'))['getDocument']>['promise']>

/** The PDF's outline (bookmarks), flattened in order. Entries whose destination can't be found are left out. */
async function outlineOf(doc: PdfDocument): Promise<OutlineEntry[]> {
	const out: OutlineEntry[] = []
	type Item = Awaited<ReturnType<PdfDocument['getOutline']>>[number]
	const walk = async (items: Item[] | null | undefined, level: number) => {
		for (const item of items ?? []) {
			if (out.length >= 2000) return
			try {
				const dest = typeof item.dest === 'string' ? await doc.getDestination(item.dest) : item.dest
				const ref = dest?.[0]
				const index = typeof ref === 'number' ? ref : ref ? await doc.getPageIndex(ref) : null
				const title = item.title.replace(/\s+/g, ' ').trim()
				// [page, { name: 'XYZ' }, left, top, zoom]: `top` is where the chapter starts.
				const top = (dest?.[1] as { name?: string } | undefined)?.name === 'XYZ' && typeof dest?.[3] === 'number' ? dest[3] : null
				if (index !== null && title) out.push({ title, level, page: index + 1, y: top })
			} catch {
				// A broken bookmark is skipped; the rest of the outline still helps.
			}
			await walk(item.items, level + 1)
		}
	}
	await walk(await doc.getOutline().catch(() => null), 1)
	return out
}

/** Reads a PDF's text with pdf.js, in chapters (see pdfChapters). A PDF with almost no text is a scan, which Life Log Club cannot read yet. */
export async function readPdf(bytes: Uint8Array, fallbackTitle: string): Promise<Pdf> {
	const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
	let doc
	try {
		doc = await getDocument({ data: bytes, isEvalSupported: false, standardFontDataUrl: FONTS, verbosity: 0 }).promise
	} catch (err) {
		throw new ExtractError(
			err instanceof Error && /password/i.test(err.message)
				? 'This PDF is locked with a password. Remove the password and add it again.'
				: "This file isn't a readable PDF. It may be damaged; try downloading it again.",
		)
	}
	const pages: PdfPage[] = []
	for (let n = 1; n <= doc.numPages; n++) {
		const page = await doc.getPage(n)
		const { width, height } = page.getViewport({ scale: 1 })
		const content = await page.getTextContent()
		// Rotated text (margin stamps such as arXiv's) is not part of the reading.
		const items = content.items.flatMap((i) =>
			'str' in i && Math.abs(i.transform[1] as number) < 0.01 && Math.abs(i.transform[2] as number) < 0.01
				? [{ str: i.str, x: i.transform[4] as number, y: i.transform[5] as number, size: Math.abs(i.transform[3] as number), width: i.width }]
				: [],
		)
		pages.push({ number: n, width, height, items })
		page.cleanup()
	}
	const chars = pages.reduce((n, p) => n + p.items.reduce((m, i) => m + i.str.trim().length, 0), 0)
	if (chars < Math.max(200, pages.length * 40))
		throw new ExtractError("This PDF is scanned pages without text, so Life Log Club can't read it yet.")
	const meta = (await doc.getMetadata().catch(() => null))?.info as { Title?: string; Author?: string } | undefined
	const outline = await outlineOf(doc)
	await doc.destroy()
	// Metadata titles are often a file name ("Microsoft Word - draft.docx"); the largest text on page 1 is the real one.
	const metaTitle = meta?.Title?.trim()
	const title = (metaTitle && words(metaTitle) >= 2 && !/\.(docx?|pdf|tex|indd)$|^microsoft word/i.test(metaTitle) ? metaTitle : '') || titleOf(pages[0]) || fallbackTitle
	return { title: title.slice(0, 200), author: meta?.Author?.trim().slice(0, 200) || null, ...pdfChapters(pages, outline, title.slice(0, 200)) }
}
