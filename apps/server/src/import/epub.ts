import { posix } from 'node:path'
import { type Block, blockText, type Chapter, countWords, type Note } from '@life-log-club/domain'
import { unzipSync } from 'fflate'
import { DOMParser, parseHTML } from 'linkedom'
import { ExtractError } from './extract'
import { type DomNode, htmlToBlocks, NOTE_TAG } from './html'
import { matterOf } from './matter'

/** Image addresses inside a book use this scheme; the path after it is the file in the archive. */
export const EPUB_SCHEME = 'epub:'
const MAX_UNZIPPED = 300 * 1024 * 1024
const MAX_FILE = 60 * 1024 * 1024
const MAX_ENTRIES = 10_000
/** Fonts, audio and video are never read, so they are not unzipped. */
const SKIPPED = /\.(ttf|otf|woff2?|eot|mp3|m4a|aac|ogg|wav|mp4|m4v|webm|mov)$/i
const NOT_EPUB = "This file isn't a readable EPUB. It may be damaged; try downloading it again."
export const DRM = "This book is protected with DRM, so Life Log Club can't read it. Try a DRM-free copy."
export const NO_TEXT = 'This book has no text Life Log Club can read.'
export const BOOK_TOO_LARGE = 'This book is too large to read. Try a smaller copy.'
/** Prefixes the headings we insert where a chapter starts; no book text contains it. */
const CHAPTER = '\u0000chapter\u0000'

export type Epub = {
	title: string
	author: string | null
	chapters: Chapter[]
	/** Footnotes and endnotes, which the chapters' note markers open. */
	notes: Note[]
	/** The book's image files, by archive path, for the image blocks to point at. */
	images: Map<string, Uint8Array>
}

type XmlDoc = ReturnType<InstanceType<typeof DOMParser>['parseFromString']>
type Document = ReturnType<typeof parseHTML>['document']
type Element = NonNullable<ReturnType<Document['getElementById']>>
type XmlEl = NonNullable<ReturnType<XmlDoc['querySelector']>>
const xml = (text: string): XmlDoc => new DOMParser().parseFromString(text, 'text/xml')
const words = (blocks: Block[]) => blocks.reduce((n, b) => n + countWords(blockText(b)), 0)
const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim()
const byLocalName = (doc: XmlDoc | XmlEl, name: string): XmlEl[] => {
	const want = name.toLowerCase()
	return [...doc.querySelectorAll('*')].filter((e) => {
		const tag = e.tagName.toLowerCase()
		return tag === want || tag.endsWith(`:${want}`)
	})
}

/** Reads the archive, refusing zip bombs: no single file, file count or total past the limits. */
function unzip(bytes: Uint8Array): Record<string, Uint8Array> {
	let total = 0
	let entries = 0
	try {
		return unzipSync(bytes, {
			filter: (f) => {
				if (++entries > MAX_ENTRIES) throw new ExtractError(BOOK_TOO_LARGE)
				if (SKIPPED.test(f.name)) return false
				total += f.originalSize
				if (f.originalSize > MAX_FILE || total > MAX_UNZIPPED) throw new ExtractError(BOOK_TOO_LARGE)
				return true
			},
		})
	} catch (err) {
		if (err instanceof ExtractError) throw err
		throw new ExtractError(NOT_EPUB)
	}
}

type TocEntry = { fragment: string | null; title: string; level: number }
type Manifest = Map<string, { href: string; type: string; props: string }>

/** A path inside the archive, from an href relative to the file `base`. */
const resolveHref = (base: string, href: string) => {
	const [file, fragment] = href.split('#')
	// "#fn3" is a place in the same file.
	const path = file ? posix.normalize(posix.join(posix.dirname(base), decodeURIComponent(file))) : base
	return { path, fragment: fragment ? decodeURIComponent(fragment) : null }
}
const key = (path: string, fragment: string | null) => (fragment ? `${path}#${fragment}` : path)

/** The semantics an element declares: `epub:type` values, and ARIA `doc-` roles without the prefix. */
const typesOf = (el: { getAttribute(name: string): string | null }) => [
	...(el.getAttribute('epub:type') ?? '').split(/\s+/).filter(Boolean),
	...(el.getAttribute('role') ?? '').split(/\s+/).flatMap((r) => (r.startsWith('doc-') ? [r.slice(4)] : [])),
]

/**
 * Chapter titles and their depth in the book's outline, by file, in order, from the EPUB 3
 * navigation document or the EPUB 2 NCX. A file can hold several chapters, each starting at the
 * element its entry's fragment names. Also returns what the book's landmarks (EPUB 3) or guide
 * (EPUB 2) say each place is, such as the cover or the copyright page.
 */
function tableOfContents(files: Record<string, Uint8Array>, opf: XmlDoc, opfDir: string, manifest: Manifest, ncxId: string | null) {
	const titles = new Map<string, TocEntry[]>()
	const landmarks = new Map<string, string[]>()
	const add = (base: string, href: string | null, title: string, level: number) => {
		if (!href || !title) return
		const { path, fragment } = resolveHref(base, href)
		const list = titles.get(path) ?? []
		if (!list.some((e) => e.fragment === fragment)) list.push({ fragment, title, level })
		titles.set(path, list)
	}
	const nav = [...manifest.values()].find((m) => m.props.split(/\s+/).includes('nav'))
	const navPath = nav && posix.join(opfDir, nav.href)
	if (navPath && files[navPath]) {
		const { document } = parseHTML(new TextDecoder().decode(files[navPath]))
		const navs = [...document.querySelectorAll('nav')]
		const toc = navs.find((n) => typesOf(n).includes('toc')) ?? document.querySelector('nav')
		for (const a of toc?.querySelectorAll('a') ?? []) {
			let level = 0
			for (let el = a.parentElement; el && el !== toc; el = el.parentElement) if (el.tagName === 'OL' || el.tagName === 'UL') level++
			add(navPath, a.getAttribute('href'), clean(a.textContent), Math.max(1, level))
		}
		for (const a of navs.find((n) => typesOf(n).includes('landmarks'))?.querySelectorAll('a') ?? []) {
			const href = a.getAttribute('href')
			if (!href) continue
			const { path, fragment } = resolveHref(navPath, href)
			landmarks.set(key(path, fragment), typesOf(a))
		}
	}
	const ncx = ncxId ? manifest.get(ncxId) : [...manifest.values()].find((m) => m.type === 'application/x-dtbncx+xml')
	const ncxPath = ncx && posix.join(opfDir, ncx.href)
	if (!titles.size && ncxPath && files[ncxPath]) {
		const doc = xml(new TextDecoder().decode(files[ncxPath]))
		for (const point of byLocalName(doc, 'navPoint')) {
			let level = 0
			for (let el: XmlEl | null = point; el; el = el.parentElement) if (/(^|:)navpoint$/i.test(el.tagName)) level++
			const label = byLocalName(point, 'text')[0]
			const content = byLocalName(point, 'content')[0]
			add(ncxPath, content?.getAttribute('src') ?? null, clean(label?.textContent), level)
		}
	}
	// EPUB 2's guide names a few places with types of its own.
	const GUIDE: Record<string, string> = { 'title-page': 'titlepage', notes: 'endnotes', 'copyright-page': 'copyright-page' }
	for (const ref of byLocalName(opf, 'reference')) {
		const href = ref.getAttribute('href')
		const type = ref.getAttribute('type')?.toLowerCase()
		if (!href || !type) continue
		const { path, fragment } = resolveHref(posix.join(opfDir, 'package.opf'), href)
		const k = key(path, fragment)
		if (!landmarks.has(k)) landmarks.set(k, [GUIDE[type] ?? type])
	}
	return { titles, landmarks }
}

type Chunk = { title: string | null; level: number | null; types: string[]; blocks: Block[] }

/**
 * Reads an EPUB in its reading order, as chapters titled and nested by its table of contents
 * (a part, its chapters, their subsections). Front and back matter is recognised by the book's
 * own semantics, then by title (see matterOf): the cover, copyright and index pages are left out,
 * a bibliography is kept as a reference, and endnotes are not a chapter. A part page keeps no
 * text, and splitBook keeps it as the parent of its chapters. Chapter XHTML goes through the
 * same conversion as web pages, so only text and the book's own images survive.
 */
export function readEpub(bytes: Uint8Array): Epub {
	const files = unzip(bytes)
	const text = (path: string) => (files[path] ? new TextDecoder().decode(files[path]) : null)

	// Encrypted chapters mean DRM (Adobe, Readium LCP, Apple). Encrypted fonts alone (font obfuscation) are fine.
	const encryption = text('META-INF/encryption.xml')
	const drmFile = ['META-INF/rights.xml', 'META-INF/license.lcpl', 'META-INF/sinf.xml'].some((f) => files[f])
	if (drmFile || (encryption && byLocalName(xml(encryption), 'CipherReference').some((r) => !/\.(ttf|otf|woff2?)$/i.test(r.getAttribute('URI') ?? ''))))
		throw new ExtractError(DRM)

	const container = text('META-INF/container.xml')
	const opfPath = container && byLocalName(xml(container), 'rootfile')[0]?.getAttribute('full-path')
	const opfText = opfPath && text(opfPath)
	if (!opfPath || !opfText) throw new ExtractError(NOT_EPUB)
	const opf = xml(opfText)
	const opfDir = posix.dirname(opfPath)
	const manifest: Manifest = new Map(
		byLocalName(opf, 'item').map((i) => [i.getAttribute('id') ?? '', { href: i.getAttribute('href') ?? '', type: i.getAttribute('media-type') ?? '', props: i.getAttribute('properties') ?? '' }]),
	)
	const spineEl = byLocalName(opf, 'spine')[0]
	const spine = byLocalName(opf, 'itemref')
		.filter((r) => r.getAttribute('linear') !== 'no')
		.map((r) => manifest.get(r.getAttribute('idref') ?? ''))
		.filter((m) => m && /html/.test(m.type))
		.map((m) => posix.normalize(posix.join(opfDir, decodeURIComponent(m!.href))))
	const { titles, landmarks } = tableOfContents(files, opf, opfDir, manifest, spineEl?.getAttribute('toc') ?? null)
	const bookTitle = clean(byLocalName(opf, 'title')[0]?.textContent) || 'Untitled book'
	const author = clean(byLocalName(opf, 'creator')[0]?.textContent) || null

	// Every file is parsed once, so note links can be followed into any of them before reading.
	const docs = new Map<string, Document | null>()
	const docOf = (path: string) => {
		if (!docs.has(path)) {
			const html = /\.x?html?$/i.test(path) ? text(path) : null
			docs.set(path, html ? parseHTML(html).document : null)
		}
		return docs.get(path)!
	}
	const notes = linkNotes(spine, docOf)

	const chunks: Chunk[] = []
	for (const path of spine) {
		const document = docOf(path)
		if (!document) continue
		const body = document.body
		// A whole file is what its body and top-level sections say it is.
		const fileTypes = [
			...typesOf(body),
			...[...body.children].filter((c) => /^(SECTION|DIV|ARTICLE)$/.test(c.tagName)).flatMap(typesOf),
			...(landmarks.get(path) ?? []),
		]
		// Mark where each chapter listed for this file starts, so one file can hold many chapters.
		const entries = titles.get(path) ?? []
		const marked: TocEntry[] = []
		const markedTypes: string[][] = []
		for (const entry of entries) {
			const target = entry.fragment && document.getElementById(entry.fragment)
			if (!target) continue
			const types = [...(landmarks.get(key(path, entry.fragment)) ?? [])]
			for (let el: typeof target | null = target; el && el !== body; el = el.parentElement) types.push(...typesOf(el))
			const marker = document.createElement('h1')
			marker.textContent = `${CHAPTER}${marked.length}`
			target.parentNode?.insertBefore(marker, target)
			marked.push(entry)
			markedTypes.push([...types, ...typesOf(body)])
		}
		const converted = htmlToBlocks(body as unknown as DomNode, `${EPUB_SCHEME}//book/${path}`, { imageSchemes: [EPUB_SCHEME], notes: true })
		// Text before the first marked chapter is the file's own entry, if it has one.
		const own = entries.find((e) => !e.fragment)
		let chunk: Chunk = { title: own?.title ?? null, level: own?.level ?? null, types: fileTypes, blocks: [] }
		chunks.push(chunk)
		for (const b of converted) {
			if (b.type === 'heading' && b.text.startsWith(CHAPTER)) {
				const n = Number(b.text.slice(CHAPTER.length))
				chunk = { title: marked[n]!.title, level: marked[n]!.level, types: markedTypes[n]!, blocks: [] }
				chunks.push(chunk)
			} else chunk.blocks.push(b)
		}
	}

	const chapters: Chapter[] = []
	// The chapter text without a title goes on with; null after a chunk that was left out.
	let current: Chapter | null = null
	let level = 1
	let textSeen = false
	for (const chunk of chunks) {
		const firstHeading = chunk.blocks.find((b) => b.type === 'heading')
		const title = chunk.title || (firstHeading?.type === 'heading' ? clean(firstHeading.text) : '')
		const n = words(chunk.blocks)
		if (!title && !n) continue
		// A file the table of contents doesn't list, with no heading, continues the chapter before
		// it: long chapters are often split across files. Before the first chapter, it is a cover
		// or title page.
		if (!title) {
			current?.blocks.push(...chunk.blocks)
			continue
		}
		// A file the table of contents doesn't list takes the level of the chapter before it.
		level = chunk.level ?? level
		current = null
		// Pictures before any text are a cover or frontispiece, whatever the book calls them.
		if (!n && !textSeen && chunk.blocks.some((b) => b.type === 'image')) continue
		textSeen ||= n > 0
		const matter = matterOf({ types: chunk.types, title })
		if (matter === 'drop' || matter === 'notes') continue
		// The chapter's own top heading usually repeats its title, sometimes with the rest of the
		// title as a paragraph after it (an hgroup: "XIX", then "That One Should Avoid…").
		const inTitle = (b: Block | undefined, type: 'heading' | 'paragraph') => b?.type === type && title.toLowerCase().includes(clean(b.text).toLowerCase())
		const headingAt = chunk.blocks.findIndex((b) => b.type !== 'image')
		let repeats = 0
		if (inTitle(chunk.blocks[headingAt], 'heading')) repeats = inTitle(chunk.blocks[headingAt + 1], 'paragraph') ? 2 : 1
		current = {
			title: title || 'Untitled',
			level,
			kind: matter === 'reference' ? 'reference' : 'body',
			blocks: chunk.blocks.filter((_, i) => i < headingAt || i >= headingAt + repeats),
		}
		chapters.push(current)
	}
	if (!chapters.some((c) => words(c.blocks) > 0)) throw new ExtractError(NO_TEXT)
	const images = new Map<string, Uint8Array>()
	for (const b of chapters.flatMap((c) => c.blocks)) {
		if (b.type !== 'image' || !b.src) continue
		const file = decodeURIComponent(new URL(b.src).pathname.replace(/^\//, ''))
		if (files[file]) images.set(b.src, files[file])
	}
	return { title: bookTitle.slice(0, 200), author: author?.slice(0, 200) ?? null, chapters, notes, images }
}

const MAX_NOTES = 5000
/** What a note marker shows: a number, a letter or a symbol, sometimes in brackets. */
const LABEL = /^[[(]?([\p{L}\p{N}*†‡§¶]{1,4})[\])]?$/u
const NOTE_TYPES = new Set(['footnote', 'endnote', 'note', 'rearnote', 'footnotes', 'endnotes', 'rearnotes'])

/**
 * Finds the book's note links and turns each into a note marker the converter keeps, with the
 * note's text read from where it points and taken out of the body. A link is a note link when the
 * book says so (`epub:type="noteref"`, `role="doc-noteref"`), or when it is a short label in a
 * superscript that points at something set as a note: an aside, a footnote or endnote, or a
 * place in a notes file. The way back to the text ("↩") is not part of the note.
 */
function linkNotes(spine: string[], docOf: (path: string) => Document | null): Note[] {
	const notes = new Map<string, Note>()
	const targets = new Set<Element>()
	for (const path of spine) {
		const doc = docOf(path)
		if (!doc) continue
		for (const a of [...doc.querySelectorAll('a[href]')]) {
			if (notes.size >= MAX_NOTES) break
			const href = a.getAttribute('href')!
			if (/^[a-z][a-z\d+.-]*:/i.test(href) || !href.includes('#')) continue
			const { path: targetPath, fragment } = resolveHref(path, href)
			const target = fragment ? docOf(targetPath)?.getElementById(fragment) : null
			const label = LABEL.exec(clean(a.textContent))?.[1]
			if (!target || !label || !isNoteLink(a, target, targetPath)) continue
			const key = `${targetPath}#${fragment}`
			let note = notes.get(key)
			if (!note) {
				const body = noteBody(target)
				for (const back of [...body.querySelectorAll('a')]) if (isBacklink(back)) back.remove()
				const blocks = htmlToBlocks(body as unknown as DomNode, `${EPUB_SCHEME}//book/${targetPath}`).filter((b) => b.type !== 'heading' && b.type !== 'image')
				note = { id: `n${notes.size + 1}`, label, blocks }
				notes.set(key, note)
				targets.add(body)
			}
			const marker = a.ownerDocument.createElement(NOTE_TAG.toLowerCase())
			marker.setAttribute('data-note', note.id)
			// A superscript that holds only the link goes with it.
			const sup = a.parentElement?.tagName === 'SUP' && clean(a.parentElement.textContent) === clean(a.textContent) ? a.parentElement : a
			sup.replaceWith(marker)
		}
	}
	for (const target of targets) removeWithEmptyParents(target)
	return [...notes.values()].filter((n) => n.blocks.length)
}

const typesUp = (el: Element) => {
	const types: string[] = []
	for (let e: Element | null = el; e && e.tagName !== 'BODY'; e = e.parentElement) types.push(...typesOf(e))
	return types
}

function isNoteLink(a: Element, target: Element, targetPath: string) {
	const types = typesOf(a)
	if (types.includes('noteref')) return true
	if (types.length) return false
	const raised = a.parentElement?.tagName === 'SUP' || !!a.querySelector('sup') || /\bnote/i.test(a.getAttribute('class') ?? '')
	const note =
		typesUp(target).some((t) => NOTE_TYPES.has(t)) ||
		!!target.closest('aside') ||
		/foot|endnote|\bnote/i.test(`${target.getAttribute('class') ?? ''} ${target.parentElement?.getAttribute('class') ?? ''}`) ||
		/notes?\b|footnote|endnote/i.test(posix.basename(targetPath))
	return raised && note
}

/** The element that holds a note's text: the target itself, or, when it points at the note's own label, the block around it. */
function noteBody(target: Element): Element {
	const inline = /^(A|SPAN|SUP|B|STRONG|EM|I|SMALL)$/
	let el = target
	while (inline.test(el.tagName) && el.parentElement && el.parentElement.tagName !== 'BODY') el = el.parentElement
	return el
}

function isBacklink(a: Element) {
	const types = typesOf(a)
	const text = clean(a.textContent)
	return types.includes('backlink') || /^[↩↑^⤴︎\s]*$/u.test(text) || ((a.getAttribute('href') ?? '').includes('#') && LABEL.test(text))
}

/** Takes a note out of the body, and the list or section around it once nothing but headings is left. */
function removeWithEmptyParents(el: Element) {
	let parent = el.parentElement
	el.remove()
	while (parent && parent.tagName !== 'BODY') {
		const rest = [...parent.childNodes].filter((n) => n.nodeType === 1 ? !/^H[1-6]$/.test((n as Element).tagName) : (n.textContent ?? '').trim())
		if (rest.length) break
		const up = parent.parentElement
		parent.remove()
		parent = up
	}
}
