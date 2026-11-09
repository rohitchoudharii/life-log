import { readFileSync } from 'node:fs'
import { type Block, blockText } from '@life-log-club/domain'
import { strToU8, zipSync } from 'fflate'
import { testEpub as epub } from './test-books'
import { describe, expect, it } from 'vitest'
import { readEpub } from './epub'
import { layoutPdf, type PdfItem, type PdfPage, readPdf } from './pdf'

const para = (n: number, word = 'word') => Array.from({ length: n }, (_, i) => `${word}${i}`).join(' ')

describe('readEpub', () => {
	it('splits files into chapters at their table-of-contents anchors, nesting inner headings', () => {
		const book = readEpub(epub({}))
		expect(book.title).toBe('Test Book')
		const headings = book.blocks.filter((b) => b.type === 'heading').map((b) => b.type === 'heading' && [b.level, b.text])
		// The cover is skipped; each chapter's own heading is not repeated under its title.
		expect(headings).toEqual([[1, 'Chapter One'], [2, 'A part'], [1, 'Chapter Two'], [1, 'Chapter Three']])
		const image = book.blocks.find((b) => b.type === 'image')
		expect(image).toMatchObject({ type: 'image', alt: 'Figure', mediaId: null, src: 'epub://book/OEBPS/images/fig.png' })
		expect(book.images.get('epub://book/OEBPS/images/fig.png')).toBeDefined()
		expect(JSON.stringify(book.blocks)).not.toContain('alert')
	})

	it('refuses a DRM-protected book but allows obfuscated fonts', () => {
		const enc = (uri: string) => `<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#"><enc:EncryptedData><enc:CipherData><enc:CipherReference URI="${uri}"/></enc:CipherData></enc:EncryptedData></encryption>`
		expect(() => readEpub(epub({ 'META-INF/encryption.xml': enc('OEBPS/text/a.xhtml') }))).toThrow(/DRM/)
		expect(() => readEpub(epub({ 'META-INF/rights.xml': '<rights/>' }))).toThrow(/DRM/)
		expect(readEpub(epub({ 'META-INF/encryption.xml': enc('OEBPS/fonts/serif.otf') })).title).toBe('Test Book')
	})

	it('refuses files that are not an EPUB', () => {
		expect(() => readEpub(zipSync({ 'readme.txt': strToU8('hi') }))).toThrow(/readable EPUB/)
		expect(() => readEpub(strToU8('not a zip at all'))).toThrow(/readable EPUB/)
	})
})

/** One line of text, as pdf.js reports a run of glyphs. */
const run = (str: string, x: number, y: number, size = 10): PdfItem => ({ str, x, y, size, width: str.length * size * 0.5 })
const page = (number: number, items: PdfItem[]): PdfPage => ({ number, width: 600, height: 800, items })

describe('layoutPdf', () => {
	it('reads two columns down the left one, then the right, after the title above them', () => {
		const left = Array.from({ length: 8 }, (_, i) => run(`left line ${i} of the first column text`, 50, 700 - i * 12))
		const right = Array.from({ length: 8 }, (_, i) => run(`right line ${i} of the second column`, 320, 700 - i * 12))
		const blocks = layoutPdf([page(1, [run('A Study of Columns', 150, 760, 18), ...right, ...left])])
		const text = blocks.flatMap((b) => ('text' in b ? [b.text] : []))
		expect(text[0]).toBe('A Study of Columns')
		expect(text[1]).toMatch(/^left line 0 .* left line 7 /)
		expect(text[2]).toMatch(/^right line 0 .* right line 7 /)
	})

	it('drops headers and page numbers repeated on every page, and keeps page markers', () => {
		const pages = [1, 2, 3].map((n) =>
			page(n, [run('Journal of Testing, Vol. 12', 50, 780, 8), run(`${para(12)} on page ${n}.`, 50, 600), run(String(n), 300, 30, 8)]),
		)
		const blocks = layoutPdf(pages)
		expect(blocks.filter((b) => b.type === 'page').map((b) => b.type === 'page' && b.number)).toEqual([1, 2, 3])
		expect(JSON.stringify(blocks)).not.toMatch(/Journal of Testing|"text":"\d"/)
	})

	it('finds headings by size and numbering, nests them, and joins words split at line ends', () => {
		const blocks = layoutPdf([
			page(1, [
				run('1 Introduction', 50, 740, 14),
				run('Spaced practice helps memory because each retrieval is an exam-', 50, 720),
				run('ple of effortful recall that strengthens the trace.', 50, 708),
				run('1.1 Background', 50, 680, 12),
				run(para(10), 50, 660),
				run('P(z) = (q/p)^z', 50, 640, 14),
			]),
		])
		expect(blocks.filter((b) => b.type === 'heading').map((b) => b.type === 'heading' && [b.level, b.text])).toEqual([
			[1, '1 Introduction'],
			[2, '1.1 Background'],
		])
		expect(blocks).toContainEqual({ type: 'paragraph', text: 'Spaced practice helps memory because each retrieval is an example of effortful recall that strengthens the trace.' })
	})
})

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`fixtures/${name}`, import.meta.url)))
const text = (blocks: Block[]) => blocks.map(blockText).join('\n')

describe('saved books', () => {
	it('The Prince (Standard Ebooks EPUB 3): title, author, chapters and text', () => {
		const book = readEpub(fixture('the-prince.epub'))
		expect([book.title, book.author]).toEqual(['The Prince', 'Niccolò Machiavelli'])
		const chapters = book.blocks.flatMap((b) => (b.type === 'heading' && b.level === 1 ? [b.text] : []))
		expect(chapters).toContain('XIX: That One Should Avoid Being Despised and Hated')
		expect(chapters.filter((c) => /^[XVI]+: /.test(c))).toHaveLength(26)
		expect(text(book.blocks)).toContain('All states, all powers, that have held and hold rule over men have been and are either republics or principalities.')
	})

	it('Trump v. Anderson (Supreme Court PDF): every page marked, and the text read in order', async () => {
		const pdf = await readPdf(fixture('trump-v-anderson.pdf'), 'fallback')
		expect(pdf.title).toBe('23-719 Trump v. Anderson (03/04/2024)')
		const pages = pdf.blocks.flatMap((b) => (b.type === 'page' ? [b.number] : []))
		expect(pages).toEqual(Array.from({ length: pages.length }, (_, i) => i + 1))
		expect(pages.length).toBeGreaterThan(10)
		expect(text(pdf.blocks)).toMatch(/Section 3 of the Fourteenth Amendment/)
	})
})
