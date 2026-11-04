import type { Block } from '@peak/core'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ExtractError } from '../web/extract'

/** A run of text on a page, with its position in PDF units (origin at the bottom left). */
export type PdfItem = { str: string; x: number; y: number; size: number; width: number }
export type PdfPage = { number: number; width: number; height: number; items: PdfItem[] }

type Line = { text: string; x: number; right: number; y: number; size: number; page: number }

const round = (n: number) => Math.round(n * 2) / 2
const words = (s: string) => s.split(/\s+/).filter(Boolean).length

/** Joins a page's text runs into lines, top to bottom and left to right. */
function linesOf(page: PdfPage): Line[] {
	const items = page.items.filter((i) => i.str.trim()).sort((a, b) => b.y - a.y || a.x - b.x)
	const lines: Line[] = []
	for (const it of items) {
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

/**
 * Turns a PDF's positioned text into blocks. Headings are lines set larger than the body text, or
 * short numbered lines like "3.1 Encoder", nested by size or numbering depth. Paragraphs are
 * joined across lines, with words broken by a hyphen at a line end put back together.
 */
export function layoutPdf(pages: PdfPage[]): Block[] {
	const perPage = pages.map(linesOf)
	const drop = repeatedMargins(pages, perPage)
	const kept = perPage.map((ls) => ls.filter((l) => !drop.has(l)))
	// The body size is the one most text is set in.
	const weight = new Map<number, number>()
	for (const l of kept.flat()) weight.set(round(l.size), (weight.get(round(l.size)) ?? 0) + l.text.length)
	const body = [...weight].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 10
	const ordered = kept.map((ls, i) => readingOrder(ls, pages[i]!.width, body))
	const letters = (s: string) => (s.match(/\p{L}/gu)?.length ?? 0) / s.replace(/\s/g, '').length
	// Formulas are often set large too, so a heading must read like words.
	const isHeading = (l: Line) =>
		l.text.length <= 120 &&
		/^[\p{Lu}\d]/u.test(l.text) &&
		letters(l.text) >= 0.6 &&
		!/[.,;:]$/.test(l.text) &&
		(round(l.size) >= body * 1.15 || (NUMBERED.test(l.text) && words(l.text) <= 12))
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

	const blocks: Block[] = []
	let para: Line[] = []
	const flush = () => {
		if (!para.length) return
		let text = ''
		for (const l of para) text = /\p{L}-$/u.test(text) && /^\p{Ll}/u.test(l.text) ? text.slice(0, -1) + l.text : text ? `${text} ${l.text}` : l.text
		blocks.push({ type: 'paragraph', text })
		para = []
	}
	ordered.forEach((lines, i) => {
		flush()
		blocks.push({ type: 'page', number: pages[i]!.number })
		lines.forEach((l, k) => {
			if (isHeading(l)) {
				flush()
				const last = blocks.at(-1)
				// A heading set on two lines arrives as two lines of the same size; much longer is a
				// passage set large (a notice on the title page), which reads as a paragraph.
				if (last?.type === 'heading' && k > 0 && Math.abs(lines[k - 1]!.size - l.size) < 0.5 && isHeading(lines[k - 1]!)) {
					if (last.text.length + l.text.length < 150) last.text += ` ${l.text}`
					else blocks[blocks.length - 1] = { type: 'paragraph', text: `${last.text} ${l.text}` }
				} else blocks.push({ type: 'heading', level: levelOf(l), text: l.text })
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
	return blocks
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

/** Reads a PDF's text with pdf.js. A PDF with almost no text is a scan, which Peak cannot read yet. */
export async function readPdf(bytes: Uint8Array, fallbackTitle: string): Promise<{ title: string; blocks: Block[] }> {
	const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
	let doc
	try {
		doc = await getDocument({ data: bytes, isEvalSupported: false, standardFontDataUrl: FONTS, verbosity: 0 }).promise
	} catch (err) {
		throw new ExtractError(err instanceof Error && /password/i.test(err.message) ? 'That PDF is password protected' : "That file isn't a readable PDF")
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
		throw new ExtractError("This PDF is scanned pages without text, so Peak can't read it yet.")
	const meta = (await doc.getMetadata().catch(() => null))?.info as { Title?: string } | undefined
	await doc.destroy()
	const blocks = layoutPdf(pages)
	// Metadata titles are often a file name ("Microsoft Word - draft.docx"); the largest text on page 1 is the real one.
	const metaTitle = meta?.Title?.trim()
	const title = (metaTitle && words(metaTitle) >= 2 && !/\.(docx?|pdf|tex|indd)$|^microsoft word/i.test(metaTitle) ? metaTitle : '') || titleOf(pages[0]) || fallbackTitle
	return { title: title.slice(0, 200), blocks }
}
