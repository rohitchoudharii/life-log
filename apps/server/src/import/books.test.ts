import { readFileSync } from 'node:fs'
import { type Block, blockText, type Chapter, splitBook } from '@life-log-club/domain'
import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { readEpub } from './epub'
import { matterOf } from './matter'
import { layoutPdf, type PdfItem, type PdfPage, pdfChapters, readPdf } from './pdf'
import { testEpub as epub, testPdf } from './test-books'

const para = (n: number, word = 'word') => Array.from({ length: n }, (_, i) => `${word}${i}`).join(' ')

const outline = (chapters: Chapter[]) => chapters.map((c) => [c.title, c.level, c.kind])
const headingsOf = (blocks: Block[]) => blocks.flatMap((b) => (b.type === 'heading' ? [[b.level, b.text]] : []))

describe('readEpub', () => {
	it('splits files into chapters at their table-of-contents anchors, keeping inner headings', () => {
		const book = readEpub(epub({}))
		expect(book.title).toBe('Test Book')
		// The cover, before the first listed chapter, is left out.
		expect(outline(book.chapters)).toEqual([
			['Chapter One', 1, 'body'],
			['Chapter Two', 1, 'body'],
			['Chapter Three', 1, 'body'],
		])
		// Each chapter's own heading is not repeated under its title.
		expect(book.chapters.map((c) => headingsOf(c.blocks))).toEqual([[[3, 'A part']], [], []])
		const image = book.chapters[1]!.blocks.find((b) => b.type === 'image')
		expect(image).toMatchObject({ type: 'image', alt: 'Figure', mediaId: null, src: 'epub://book/OEBPS/images/fig.png' })
		expect(book.images.get('epub://book/OEBPS/images/fig.png')).toBeDefined()
		expect(JSON.stringify(book.chapters)).not.toContain('alert')
	})

	it('keeps the outline nesting, and recognises front and back matter by its semantics or its title', () => {
		const items = ['cover', 'titlepage', 'part', 'ch1', 'ch1b', 'notes', 'bib', 'legal', 'about']
		const page = (body: string, attrs = '') => `<html xmlns:epub="http://www.idpf.org/2007/ops"><body${attrs}>${body}</body></html>`
		const text = (word: string) => `<p>${para(30, word)}</p>`
		const book = readEpub(
			epub({
				'OEBPS/book.opf': `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>Matter</dc:title><dc:creator>A. Writer</dc:creator></metadata>
					<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${items.map((i) => `<item id="${i}" href="${i}.xhtml" media-type="application/xhtml+xml"/>`).join('')}</manifest>
					<spine>${items.map((i) => `<itemref idref="${i}"/>`).join('')}</spine><guide><reference type="copyright-page" href="legal.xhtml"/></guide></package>`,
				'OEBPS/nav.xhtml': page(`<nav epub:type="toc"><ol>
					<li><a href="cover.xhtml">Cover</a></li><li><a href="titlepage.xhtml">The Matter Book</a></li>
					<li><a href="part.xhtml">Part One</a><ol><li><a href="ch1.xhtml">1. Arrival</a><ol><li><a href="ch1.xhtml#s2">The harbour</a></li></ol></li></ol></li>
					<li><a href="notes.xhtml">Endnotes</a></li><li><a href="bib.xhtml">7 References</a></li><li><a href="legal.xhtml">Legal</a></li><li><a href="about.xhtml">About the Author</a></li></ol></nav>
					<nav epub:type="landmarks"><ol><li><a epub:type="cover" href="cover.xhtml">Cover</a></li></ol></nav>`),
				'OEBPS/cover.xhtml': page(text('cover')),
				'OEBPS/titlepage.xhtml': page(`<section epub:type="titlepage"><h1>The Matter Book</h1>${text('title')}</section>`),
				'OEBPS/part.xhtml': page('<h1>Part One</h1>', ' epub:type="bodymatter"'),
				'OEBPS/ch1.xhtml': page(`<section epub:type="chapter"><h2>1. Arrival</h2>${text('arrive')}<h3 id="s2">The harbour</h3>${text('harbour')}</section>`),
				// A file the table of contents doesn't list goes on with the chapter before it.
				'OEBPS/ch1b.xhtml': page(text('later')),
				'OEBPS/notes.xhtml': page(`<section epub:type="endnotes"><ol><li>${text('note')}</li></ol></section>`),
				'OEBPS/bib.xhtml': page(text('source')),
				'OEBPS/legal.xhtml': page(text('rights')),
				'OEBPS/about.xhtml': page(text('bio')),
			}),
		)
		expect(book.author).toBe('A. Writer')
		expect(outline(book.chapters)).toEqual([
			['Part One', 1, 'body'],
			['1. Arrival', 2, 'body'],
			['The harbour', 3, 'body'],
			['7 References', 1, 'reference'],
		])
		const all = JSON.stringify(book.chapters)
		for (const left of ['cover0', 'title0', 'note0', 'rights0', 'bio0']) expect(all).not.toContain(left)
		expect(blockText(book.chapters[2]!.blocks.at(-1)!)).toMatch(/^later0/)
		// The part page has no text, and stays as the parent of its chapter.
		expect(splitBook(book.chapters).map((s) => [s.title, s.level])).toEqual([
			['Part One', 1],
			['1. Arrival', 2],
			['The harbour', 3],
			['7 References', 1],
		])
	})

	it('opens notes from their markers, and takes the notes out of the text', () => {
		const book = readEpub(
			epub({
				'OEBPS/text/a.xhtml': `<html xmlns:epub="http://www.idpf.org/2007/ops"><body><h2 id="c1">Chapter One</h2>
					<p>Fact<a epub:type="noteref" href="notes.xhtml#n-1" id="r1">1</a> here, and more<sup><a href="notes.xhtml#n-2" id="r2">2</a></sup>.</p>
					<p>Claim<a href="#fn3"><sup>*</sup></a>, <a href="b.xhtml#top">see three</a>.</p>
					<aside id="fn3"><p>An aside note.</p></aside>
					<h2 id="c2">Chapter Two</h2><p>${para(80, 'two')}</p></body></html>`,
				// Not in the spine: notes files often aren't.
				'OEBPS/text/notes.xhtml': `<html xmlns:epub="http://www.idpf.org/2007/ops"><body><ol>
					<li id="n-1"><p>First note. <a epub:type="backlink" href="a.xhtml#r1">↩</a></p></li>
					<li id="n-2"><p><a href="a.xhtml#r2">2</a> Second note.</p></li></ol></body></html>`,
			}),
		)
		const [one] = book.chapters
		expect(one!.blocks.slice(0, 2)).toEqual([
			{
				type: 'paragraph',
				text: 'Fact here, and more.',
				notes: [
					{ at: 4, id: 'n1' },
					{ at: 19, id: 'n2' },
				],
			},
			// A link to another place in the book is no note.
			{ type: 'paragraph', text: 'Claim, see three.', notes: [{ at: 5, id: 'n3' }] },
		])
		expect(book.notes).toEqual([
			{ id: 'n1', label: '1', blocks: [{ type: 'paragraph', text: 'First note.' }] },
			{ id: 'n2', label: '2', blocks: [{ type: 'paragraph', text: 'Second note.' }] },
			{ id: 'n3', label: '*', blocks: [{ type: 'paragraph', text: 'An aside note.' }] },
		])
		expect(JSON.stringify(book.chapters)).not.toContain('aside note')
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

	it('keeps a raised note marker in its line, so the text after it is no numbered heading', () => {
		// As a court opinion sets it: the marker sits higher, and the text after it is a hair off the baseline.
		const lead = run('Art. II, §1, cl. 2.', 50, 519.1787, 11)
		const blocks = layoutPdf([
			page(1, [run(para(12), 50, 545, 11), run(para(12), 50, 532, 11), lead, { str: '1', x: 50 + lead.width, y: 522.18, size: 7, width: 4 }, run('But there is little reason to think that', 50 + lead.width + 13, 519.18, 11)]),
		])
		expect(blocks.filter((b) => b.type === 'heading')).toEqual([])
		expect(JSON.stringify(blocks)).toMatch(/cl\. 2\. ?1 But there is little reason/)
	})

	it('opens a footnote from its raised marker, and keeps the text of markers and notes that match nothing', () => {
		const lead = run('Body text before the marker', 50, 700)
		const exponent = run('Ten to the', 50, 680)
		const second = run(`${para(12)} again`, 50, 700)
		const body = Array.from({ length: 10 }, (_, i) => run(`${para(12)}.`, 50, 600 - i * 12))
		const pages = [
			page(1, [
				lead,
				{ str: '1', x: 50 + lead.width, y: 703, size: 6, width: 3 },
				run('and after it.', 50 + lead.width + 5, 700),
				exponent,
				{ str: '6', x: 50 + exponent.width, y: 683, size: 6, width: 3 },
				...body,
				run('1 The note says this much', 50, 100, 8),
				run('and goes on here.', 50, 90, 8),
			]),
			page(2, [second, { str: '3', x: 50 + second.width, y: 703, size: 6, width: 3 }, ...body, run('still the first note.', 50, 100, 8), run('3 Third note.', 50, 90, 8), run('4 Nobody points here.', 50, 80, 8)]),
		]
		const { chapters, notes } = pdfChapters(pages, [], 'Doc')
		expect(notes).toEqual([
			{ id: 'p1-1', label: '1', blocks: [{ type: 'paragraph', text: 'The note says this much and goes on here. still the first note.' }] },
			{ id: 'p2-3', label: '3', blocks: [{ type: 'paragraph', text: 'Third note.' }] },
		])
		const blocks = chapters.flatMap((c) => c.blocks)
		expect(blocks).toContainEqual({ type: 'paragraph', text: 'Body text before the marker and after it.', notes: [{ at: 27, id: 'p1-1' }] })
		// No note 6 on the page: the raised 6 is an exponent, and stays in the text.
		expect(blocks).toContainEqual({ type: 'paragraph', text: 'Ten to the6' })
		expect(blocks).toContainEqual({ type: 'paragraph', text: '4 Nobody points here.' })
		expect(JSON.stringify(blocks)).not.toMatch(/note says|Third note/)
	})

	it('reads the same large line near the top of three pages as a running title, not a heading', () => {
		const pages = [1, 2, 3].map((n) => page(n, [run('SUPREME COURT OF THE UNITED STATES', 50, 600, 15), run(`${para(14)} ${n}.`, 50, 560), run(`${para(14)} ${n}.`, 50, 548)]))
		expect(layoutPdf(pages).filter((b) => b.type === 'heading')).toEqual([])
	})
})

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`fixtures/${name}`, import.meta.url)))
const text = (blocks: Block[]) => blocks.map(blockText).join('\n')

describe('matterOf', () => {
	it('reads EPUB semantics first, then the title without its number', () => {
		expect(matterOf({ types: ['frontmatter', 'dedication'], title: 'For my mother' })).toBe('drop')
		expect(matterOf({ types: ['bibliography'], title: 'The Man and His Works' })).toBe('reference')
		expect(matterOf({ types: ['endnotes', 'footnotes'], title: 'Notes' })).toBe('notes')
		// A chapter is the book, whatever it is called.
		expect(matterOf({ types: ['chapter'], title: 'Index' })).toBe('body')
		expect(matterOf({ title: '7 References' })).toBe('reference')
		expect(matterOf({ title: 'Table of Contents' })).toBe('drop')
		expect(matterOf({ title: 'Index' })).toBe('drop')
		for (const title of ['Introduction', 'Preface', 'Appendix A: Proofs', 'Epilogue', 'Indexing at scale']) expect(matterOf({ title }), title).toBe('body')
	})
})

describe('pdfChapters', () => {
	const body = (word: string, y: number, lines = 3) => Array.from({ length: lines }, (_, i) => run(`${word} ${para(10, word)}`, 50, y - i * 12))

	it("splits at the outline's entries, at the heading that repeats each title or where the entry points", () => {
		const pages = [
			page(1, [run('Retrieval Practice', 50, 760, 18), ...body('abstract', 700)]),
			// A table of contents page, read from its dot leaders.
			page(2, ['1 Introduction', '1.1 Background', '2 Method', 'References'].map((t, i) => run(`${t} . . . . . . . . . 3`, 50, 700 - i * 14))),
			page(3, [run('1 Introduction', 50, 740, 14), ...body('intro', 720), run('1.1 Background', 50, 660, 12), ...body('background', 640)]),
			// 'Method' has no heading of its own; the outline says it starts halfway down page 4.
			page(4, [...body('before', 700), ...body('method', 400)]),
			page(5, [run('References', 50, 740, 14), ...body('source', 720)]),
		]
		const { chapters, article } = pdfChapters(
			pages,
			[
				{ title: 'Introduction', level: 1, page: 3, y: null },
				{ title: 'Background', level: 2, page: 3, y: null },
				{ title: 'Method', level: 1, page: 4, y: 401 },
			],
			'Retrieval Practice',
		)
		expect(article).toBe(false)
		expect(outline(chapters)).toEqual([
			['Retrieval Practice', 1, 'body'],
			['Introduction', 1, 'body'],
			['Background', 2, 'body'],
			['Method', 1, 'body'],
			// Not in the outline, but a heading that names back matter.
			['References', 1, 'reference'],
		])
		const text = chapters.map((c) => c.blocks.map(blockText).join(' '))
		expect(text[0]).toMatch(/abstract/)
		expect(text.join(' ')).not.toMatch(/\. \. \./)
		// Headings that repeat a chapter's title are not kept twice.
		expect(chapters.flatMap((c) => headingsOf(c.blocks)).map(([, t]) => t)).toEqual(['Retrieval Practice'])
		expect(text[2]).toMatch(/background/)
		expect(text[2]).toMatch(/before/)
		expect(text[3]).toMatch(/^method/)
		// Each chapter that starts a page holds that page's marker.
		expect(chapters[1]!.blocks[0]).toEqual({ type: 'page', number: 3 })
	})

	it('reads a PDF with no outline and no headings as one article', () => {
		const { chapters, article } = pdfChapters([page(1, body('plain', 700, 8)), page(2, body('more', 700, 8))], [], 'Memo')
		expect(article).toBe(true)
		expect(outline(chapters)).toEqual([['Memo', 1, 'body']])
	})

	it('reads the outline of a real PDF file', async () => {
		const pdf = await readPdf(
			testPdf(
				[
					[['Spacing Effects', 20], ...Array(6).fill('An opening paragraph that sets out the question this short paper asks.')],
					['Some text about spacing that is long enough to read as a paragraph.', ...Array(5).fill('More of the first chapter, set in the body size.')],
					['The second chapter starts at the top of this page with its own words.', ...Array(5).fill('More of the second chapter, set in the body size.')],
				],
				[
					{ title: 'Part I: Spacing', page: 2, items: [{ title: 'Why it works', page: 2, top: 730 }] },
					{ title: 'Part II: Testing', page: 3 },
				],
			),
			'fallback',
		)
		expect(pdf.title).toBe('Spacing Effects')
		expect(outline(pdf.chapters)).toEqual([
			['Spacing Effects', 1, 'body'],
			['Part I: Spacing', 1, 'body'],
			['Why it works', 2, 'body'],
			['Part II: Testing', 1, 'body'],
		])
		expect(blockText(pdf.chapters[2]!.blocks.find((b) => b.type === 'paragraph')!)).toMatch(/^Some text about spacing/)
	})
})

describe('saved books', () => {
	it('The Prince (Standard Ebooks EPUB 3): its own outline, without front and back matter', () => {
		const book = readEpub(fixture('the-prince.epub'))
		expect([book.title, book.author]).toEqual(['The Prince', 'Niccolò Machiavelli'])
		const chapters = outline(book.chapters)
		expect(chapters.slice(0, 6)).toEqual([
			['Introduction', 1, 'body'],
			['Youth', 2, 'body'],
			['Office', 2, 'body'],
			['Literature and Death', 2, 'body'],
			['The Man and His Works', 1, 'reference'],
			['The Prince', 1, 'body'],
		])
		expect(chapters.slice(6).filter(([t, level]) => /^[XVI]+: /.test(t as string) && level === 2)).toHaveLength(26)
		expect(chapters).toHaveLength(32)
		// Chapter I opens with its text, not its subtitle again (the book sets "I" and the subtitle as an hgroup).
		expect(blockText(book.chapters[6]!.blocks[0]!)).toMatch(/^All states, all powers/)
		expect(text(book.chapters.flatMap((c) => c.blocks))).toContain('All states, all powers, that have held and hold rule over men have been and are either republics or principalities.')
		// 47 of the 48 endnotes are opened from the chapters kept; the endnotes file is no chapter.
		const opened = new Set(book.chapters.flatMap((c) => c.blocks.flatMap((b) => ('notes' in b ? (b.notes ?? []).map((n) => n.id) : []))))
		expect([book.notes.length, opened.size]).toEqual([48, 47])
		expect(book.notes[0]).toEqual({ id: 'n1', label: '1', blocks: [{ type: 'paragraph', text: expect.stringMatching(/^Duke Lodovico was Lodovico Moro, .* died in 1510\.$/) }] })
		expect(text(book.chapters.flatMap((c) => c.blocks))).not.toContain('Duke Lodovico was Lodovico Moro')
		// The three long chapters without headings wait for the AI; the others are split now.
		expect([...new Set(splitBook(book.chapters).filter((s) => s.headingsPending).map((s) => s.title.replace(/ \(part \d\)$/, '')))]).toEqual([
			'III: Concerning Mixed Principalities',
			'VII: Concerning New Principalities Which Are Acquired Either by the Arms of Others or by Good Fortune',
			'XIX: That One Should Avoid Being Despised and Hated',
		])
	})

	it('Trump v. Anderson (Supreme Court PDF): read as one article, every page marked, and the text in order', async () => {
		const pdf = await readPdf(fixture('trump-v-anderson.pdf'), 'fallback')
		expect(pdf.title).toBe('23-719 Trump v. Anderson (03/04/2024)')
		// No outline, and no headings once its running title and note markers are read right.
		expect(pdf.article).toBe(true)
		expect(outline(pdf.chapters)).toEqual([[pdf.title, 1, 'body']])
		const blocks = pdf.chapters[0]!.blocks
		expect(headingsOf(blocks)).toEqual([])
		const pages = blocks.flatMap((b) => (b.type === 'page' ? [b.number] : []))
		expect(pages).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
		expect(text(blocks)).toMatch(/Section 3 of the Fourteenth Amendment/)
		// Its footnotes open from their markers, and are no longer read as body text.
		expect(pdf.notes.map((n) => [n.label, blockText(n.blocks[0]!)])).toEqual([
			['1', expect.stringMatching(/^The Elections Clause directs, in relevant part/)],
			['2', expect.stringMatching(/^Shortly after the Fourteenth Amendment was ratified/)],
			['3', expect.stringMatching(/^We are aware of just one example of state enforcement/)],
		])
		expect(text(blocks)).not.toContain('The Elections Clause directs')
		expect(blocks).toContainEqual(expect.objectContaining({ text: expect.stringContaining('Art. II, §1, cl. 2. But there is little reason'), notes: expect.arrayContaining([expect.objectContaining({ id: 'p8-1' })]) }))
	})
})
