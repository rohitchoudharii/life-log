import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { type Block, type Chapter, countWords, type Note, type NoteRef } from '@life-log-club/domain'
import { ExtractError } from './extract'
import { matterOf } from './matter'

/** A run of text on a page, with its position in PDF units (origin at the bottom left). */
export type PdfItem = { str: string; x: number; y: number; size: number; width: number }
export type PdfPage = { number: number; width: number; height: number; items: PdfItem[] }

type Line = { text: string; x: number; right: number; y: number; size: number; page: number }

const round = (n: number) => Math.round(n * 2) / 2
const words = countWords

/** A raised note marker inside a line's text, with its label: "\u00013\u0002". Neither character is in real text. */
const MARK_OPEN = '\u0001'
const MARK_CLOSE = '\u0002'
const MARK = /\u0001([^\u0002]*)\u0002/g
/** A line's text with its markers' labels put back as plain text ("10⁶" reads "106", as before). */
const unmarked = (text: string) => text.replace(MARK, '$1')

/** Joins a page's text runs into lines, top to bottom and left to right. */
function linesOf(page: PdfPage): Line[] {
	const items = page.items.filter((i) => i.str.trim()).map((i) => ({ ...i }))
	// A note marker is set small and raised above the line it belongs to; read on its own, it
	// would start a line ("1 But there is…") that looks like a numbered heading.
	// It is kept as a marker (see MARK) for layout to link to its note.
	const markers = new Set<PdfItem>()
	for (const it of items) {
		if (!/^[\d*†‡]{1,3}$/.test(it.str.trim())) continue
		const hosts = items.filter((o) => o.size > it.size * 1.25 && it.y > o.y && it.y - o.y < o.size * 0.6)
		const host = hosts.sort((a, b) => Math.abs(a.x - it.x) - Math.abs(b.x - it.x))[0]
		if (!host) continue
		it.y = host.y
		markers.add(it)
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
		const str = markers.has(it) ? `${MARK_OPEN}${it.str.trim()}${MARK_CLOSE}` : it.str
		if (line && it.x - line.right < reach && it.x > line.right - it.size) {
			const gap = it.x - line.right
			line.text += (gap > it.size * 0.15 && !markers.has(it) && !line.text.endsWith(' ') && !it.str.startsWith(' ') ? ' ' : '') + str
			line.right = Math.max(line.right, it.x + it.width)
			line.size = Math.max(line.size, it.size)
		} else lines.push({ text: str, x: it.x, right: it.x + it.width, y: it.y, size: it.size, page: page.number })
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
function layout(pages: PdfPage[]): { placed: Placed[]; notes: Note[] } {
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
	const notes: Note[] = []
	// This page's footnotes, by label, and whether a marker in the text opens each.
	let footnotes = new Map<string, { note: Note; lines: Line[]; used: boolean }>()
	let para: Line[] = []
	const flush = () => {
		if (!para.length) return
		const { text, notes: refs } = markersOf(joinLines(para), (label) => {
			const found = footnotes.get(label)
			if (!found) return null
			found.used = true
			return found.note.id
		})
		out.push({ block: { type: 'paragraph', text, ...(refs.length && { notes: refs }) }, page: para[0]!.page, y: para[0]!.y })
		para = []
	}
	let lastNote: { note: Note; lines: Line[] } | null = null
	ordered.forEach((all, i) => {
		flush()
		const page = pages[i]!.number
		const { body: lines, notes: found, continued } = footnoteZone(all, body)
		// Small lines at the top of the zone with no label go on with the last note of the page before.
		if (lastNote && continued.length) {
			lastNote.lines.push(...continued)
			lastNote.note.blocks = [{ type: 'paragraph', text: markersOf(joinLines(lastNote.lines), () => null).text }]
		} else lines.push(...continued)
		footnotes = new Map()
		for (const f of found)
			if (!footnotes.has(f.label))
				footnotes.set(f.label, { note: { id: `p${page}-${f.label}`, label: f.label, blocks: [{ type: 'paragraph', text: markersOf(joinLines(f.lines), () => null).text }] }, lines: f.lines, used: false })
		out.push({ block: { type: 'page', number: page }, page, y: Number.POSITIVE_INFINITY })
		lines.forEach((l, k) => {
			if (isHeading(l)) {
				flush()
				const last = out.at(-1)
				// A heading set on two lines arrives as two lines of the same size; much longer is a
				// passage set large (a notice on the title page), which reads as a paragraph.
				const text = unmarked(l.text)
				if (last?.block.type === 'heading' && k > 0 && Math.abs(lines[k - 1]!.size - l.size) < 0.5 && isHeading(lines[k - 1]!)) {
					if (last.block.text.length + text.length < 150) last.block.text += ` ${text}`
					else last.block = { type: 'paragraph', text: `${last.block.text} ${text}` }
				} else out.push({ block: { type: 'heading', level: levelOf(l), text }, page: l.page, y: l.y })
				return
			}
			const prev = para.at(-1)
			const gap = prev ? prev.y - l.y : 0
			// A new paragraph after a blank gap, or at an indented first line.
			if (prev && (gap > prev.size * 1.8 || gap < 0 || l.x - prev.x > l.size * 1.2)) flush()
			para.push(l)
		})
		flush()
		// A footnote no marker opens stays in the text, where the page printed it.
		for (const f of footnotes.values()) {
			if (f.used) notes.push(f.note)
			else out.push({ block: { type: 'paragraph', text: `${f.note.label} ${unmarked(joinLines(f.lines))}` }, page, y: f.lines[0]!.y })
		}
		const last = [...footnotes.values()].at(-1)
		lastNote = last?.used ? last : null
	})
	flush()
	return { placed: out, notes }
}

/** Joins lines into a paragraph's text, putting back together words broken by a hyphen at a line end. */
function joinLines(lines: Line[]) {
	let text = ''
	for (const l of lines) text = /\p{L}-$/u.test(text) && /^\p{Ll}/u.test(l.text) ? text.slice(0, -1) + l.text : text ? `${text} ${l.text}` : l.text
	return text
}

/**
 * Takes the markers out of a paragraph's text. `open` returns the id of the note a label opens on
 * this page; a marker with none (an exponent, or a note on another page) keeps its label as text.
 */
function markersOf(text: string, open: (label: string) => string | null): { text: string; notes: NoteRef[] } {
	let out = ''
	const notes: NoteRef[] = []
	let last = 0
	for (const m of text.matchAll(MARK)) {
		out += text.slice(last, m.index)
		const id = open(m[1]!)
		if (id) notes.push({ at: out.length, id })
		else out += m[1]
		last = m.index + m[0].length
	}
	return { text: out + text.slice(last), notes }
}

/** A footnote's first line: its label, raised or not, then its text. */
const NOTE_START = /^(?:\u0001([\d*†‡]{1,3})\u0002\s*|(\d{1,3}|[*†‡])\s+)(?=\p{L}|[“"‘(])/u

/**
 * Splits a page's lines into its body and its footnotes: the lines at the foot of the page set
 * smaller than the body text, each note starting at a line that begins with its label.
 * `continued` are the small lines before the first label, which go on with a note from the page
 * before.
 */
function footnoteZone(lines: Line[], body: number) {
	let start = lines.length
	while (start > 0 && round(lines[start - 1]!.size) < body - 0.5) start--
	const zone = lines.slice(start)
	const first = zone.findIndex((l) => NOTE_START.test(l.text))
	if (first < 0) return { body: lines, notes: [], continued: [] }
	const notes: { label: string; lines: Line[] }[] = []
	for (const l of zone.slice(first)) {
		const m = NOTE_START.exec(l.text)
		if (m) notes.push({ label: m[1] ?? m[2]!, lines: [{ ...l, text: l.text.slice(m[0].length) }] })
		else notes.at(-1)!.lines.push(l)
	}
	return { body: lines.slice(0, start), notes, continued: zone.slice(0, first) }
}

/**
 * Turns a PDF's positioned text into blocks. Headings are lines set larger than the body text, or
 * short numbered lines like "3.1 Encoder", nested by size or numbering depth. Paragraphs are
 * joined across lines, with words broken by a hyphen at a line end put back together. Table of
 * contents pages are left out. A footnote opened by a raised marker in the text is taken out of
 * the text, and the marker opens it (see pdfChapters for the notes).
 */
export const layoutPdf = (pages: PdfPage[]): Block[] => layout(pages).placed.map((p) => p.block)

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
export function pdfChapters(pages: PdfPage[], outline: OutlineEntry[], title: string): { chapters: Chapter[]; article: boolean; notes: Note[] } {
	const { placed, notes } = layout(pages)
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
	return { chapters, article: !starts.length, notes }
}

/** The largest text on the first page, joined across its lines. */
function titleOf(page: PdfPage | undefined): string {
	if (!page) return ''
	const lines = linesOf(page)
	const top = Math.max(0, ...lines.map((l) => l.size))
	const text = lines.filter((l) => l.size >= top - 0.5).map((l) => unmarked(l.text)).join(' ')
	return words(text) <= 25 ? text : ''
}

const require = createRequire(import.meta.url)
const FONTS = pathToFileURL(join(dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts') + '/').href

export type Pdf = { title: string; author: string | null; chapters: Chapter[]; article: boolean; notes: Note[] }

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

/** The most scanned pages read in one file: about 10 minutes of OCR. */
export const MAX_SCANNED_PAGES = 400
export const SCAN_TOO_LONG = `This scanned PDF has more than ${MAX_SCANNED_PAGES} pages. Split it into parts and add each one.`
export const SCAN_UNREADABLE = "This PDF is scanned pages, and no text could be read from them. Try a sharper scan, or a copy with text."
/** Pages are drawn at twice their size, about 150 dots per inch, for OCR. */
const OCR_SCALE = 2

type PdfDoc = Awaited<ReturnType<(typeof import('pdfjs-dist/legacy/build/pdf.mjs'))['getDocument']>['promise']>

/**
 * Reads a scan's pages with OCR (Tesseract, in English, on this server: no AI key and no cost).
 * Each line read becomes one text item where it stands on the page, sized by the height of its row,
 * so the same rules split it into chapters and paragraphs as a PDF with a text layer.
 */
async function ocrPages(doc: PdfDoc, onPage: (done: number, total: number) => void): Promise<PdfPage[]> {
	const { createCanvas } = await import('@napi-rs/canvas')
	const { createWorker } = await import('tesseract.js')
	// The English data ships as a package, so OCR never downloads anything.
	const { langPath } = createRequire(import.meta.url)('@tesseract.js-data/eng') as { langPath: string }
	const worker = await createWorker('eng', 1, { langPath, gzip: true, cacheMethod: 'none' })
	const pages: PdfPage[] = []
	try {
		onPage(0, doc.numPages)
		for (let n = 1; n <= doc.numPages; n++) {
			const page = await doc.getPage(n)
			const { width, height } = page.getViewport({ scale: 1 })
			const viewport = page.getViewport({ scale: OCR_SCALE })
			const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
			const context = canvas.getContext('2d')
			// A scan is an image over a white page; transparency would read as black.
			context.fillStyle = 'white'
			context.fillRect(0, 0, canvas.width, canvas.height)
			await page.render({ canvas: canvas as never, canvasContext: context as never, viewport }).promise
			const { data } = await worker.recognize(canvas.toBuffer('image/png'), {}, { blocks: true, text: false })
			const lines = (data.blocks ?? []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines))
			const items = lines
				.filter((l) => l.confidence >= 40 && l.text.trim())
				.map((l) => ({
					str: l.text.trim(),
					x: l.bbox.x0 / OCR_SCALE,
					y: height - l.baseline.y0 / OCR_SCALE,
					// Rows of one type size have about the same height; whole points keep them together.
					size: Math.round((l.rowAttributes?.rowHeight || l.bbox.y1 - l.bbox.y0) / OCR_SCALE),
					width: (l.bbox.x1 - l.bbox.x0) / OCR_SCALE,
				}))
			pages.push({ number: n, width, height, items })
			page.cleanup()
			onPage(n, doc.numPages)
		}
	} finally {
		await worker.terminate()
	}
	return pages
}

const charsIn = (pages: PdfPage[]) => pages.reduce((n, p) => n + p.items.reduce((m, i) => m + i.str.trim().length, 0), 0)
const tooLittle = (pages: PdfPage[]) => charsIn(pages) < Math.max(200, pages.length * 40)

/**
 * Reads a PDF's text with pdf.js, in chapters (see pdfChapters). A PDF with almost no text is a
 * scan: its pages are read with OCR instead, reporting each page done to `onScanPage`.
 */
export async function readPdf(bytes: Uint8Array, fallbackTitle: string, onScanPage: (done: number, total: number) => void = () => {}): Promise<Pdf> {
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
	if (tooLittle(pages)) {
		if (doc.numPages > MAX_SCANNED_PAGES) throw new ExtractError(SCAN_TOO_LONG)
		pages.splice(0, pages.length, ...(await ocrPages(doc, onScanPage)))
		if (tooLittle(pages)) throw new ExtractError(SCAN_UNREADABLE)
	}
	const meta = (await doc.getMetadata().catch(() => null))?.info as { Title?: string; Author?: string } | undefined
	const outline = await outlineOf(doc)
	await doc.destroy()
	// Metadata titles are often a file name ("Microsoft Word - draft.docx"); the largest text on page 1 is the real one.
	const metaTitle = meta?.Title?.trim()
	const title = (metaTitle && words(metaTitle) >= 2 && !/\.(docx?|pdf|tex|indd)$|^microsoft word/i.test(metaTitle) ? metaTitle : '') || titleOf(pages[0]) || fallbackTitle
	return { title: title.slice(0, 200), author: meta?.Author?.trim().slice(0, 200) || null, ...pdfChapters(pages, outline, title.slice(0, 200)) }
}
