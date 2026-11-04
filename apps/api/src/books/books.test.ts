import { zipSync, strToU8 } from 'fflate'
import { describe, expect, it } from 'vitest'
import { readEpub } from './epub'
import { layoutPdf, type PdfItem, type PdfPage } from './pdf'

const para = (n: number, word = 'word') => Array.from({ length: n }, (_, i) => `${word}${i}`).join(' ')

function epub(files: Record<string, string>) {
	return zipSync({
		mimetype: strToU8('application/epub+zip'),
		'META-INF/container.xml': strToU8('<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/book.opf"/></rootfiles></container>'),
		'OEBPS/book.opf': strToU8(`<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>Test Book</dc:title></metadata>
			<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/><item id="a" href="text/a.xhtml" media-type="application/xhtml+xml"/><item id="b" href="text/b.xhtml" media-type="application/xhtml+xml"/><item id="img" href="images/fig.png" media-type="image/png"/></manifest>
			<spine><itemref idref="cover"/><itemref idref="a"/><itemref idref="b"/></spine></package>`),
		'OEBPS/nav.xhtml': strToU8(`<html xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol>
			<li><a href="text/a.xhtml#c1">Chapter One</a></li><li><a href="text/a.xhtml#c2">Chapter Two</a></li><li><a href="text/b.xhtml">Chapter Three</a></li></ol></nav></body></html>`),
		'OEBPS/cover.xhtml': strToU8('<html><body><p>Cover</p></body></html>'),
		'OEBPS/text/a.xhtml': strToU8(`<html><body><h2 id="c1">Chapter One</h2><p>${para(80, 'one')}</p><h3>A part</h3><p>${para(70, 'part')}</p>
			<h2 id="c2">Chapter Two</h2><p>${para(80, 'two')}</p><img src="../images/fig.png" alt="Figure"/></body></html>`),
		'OEBPS/text/b.xhtml': strToU8(`<html><body><h1>Chapter Three</h1><p>${para(90, 'three')}</p><script>alert(1)</script></body></html>`),
		'OEBPS/images/fig.png': strToU8('png bytes'),
		...Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])),
	})
}

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
