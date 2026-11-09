import { posix } from 'node:path'
import { type Block, blockText, countWords } from '@life-log-club/domain'
import { unzipSync } from 'fflate'
import { DOMParser, parseHTML } from 'linkedom'
import { ExtractError } from './extract'
import { type DomNode, htmlToBlocks } from './html'

/** Image addresses inside a book use this scheme; the path after it is the file in the archive. */
export const EPUB_SCHEME = 'epub:'
const MAX_UNZIPPED = 300 * 1024 * 1024
const MAX_FILE = 60 * 1024 * 1024
const MAX_ENTRIES = 10_000
/** Fonts, audio and video are never read, so they are not unzipped. */
const SKIPPED = /\.(ttf|otf|woff2?|eot|mp3|m4a|aac|ogg|wav|mp4|m4v|webm|mov)$/i
const NOT_EPUB = "This file isn't a readable EPUB. It may be damaged; try downloading it again."
export const DRM = "This book is protected with DRM, so Life Log Club can't read it. Try a DRM-free copy."
export const BOOK_TOO_LARGE = 'This book is too large to read. Try a smaller copy.'
/** Prefixes the headings we insert where a chapter starts; no book text contains it. */
const CHAPTER = '\u0000chapter\u0000'

export type Epub = {
	title: string
	author: string | null
	blocks: Block[]
	/** The book's image files, by archive path, for the image blocks to point at. */
	images: Map<string, Uint8Array>
}

type XmlDoc = ReturnType<InstanceType<typeof DOMParser>['parseFromString']>
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

type TocEntry = { fragment: string | null; title: string }

/**
 * Chapter titles by file, in order, from the EPUB 3 navigation document or the EPUB 2 NCX. A
 * file can hold several chapters, each starting at the element its entry's fragment names.
 */
function tableOfContents(files: Record<string, Uint8Array>, opfDir: string, manifest: Map<string, { href: string; type: string; props: string }>, ncxId: string | null) {
	const titles = new Map<string, TocEntry[]>()
	const add = (base: string, href: string | null, title: string) => {
		if (!href || !title) return
		const [file, fragment] = href.split('#')
		const path = posix.normalize(posix.join(posix.dirname(base), decodeURIComponent(file!)))
		const list = titles.get(path) ?? []
		if (!list.some((e) => e.fragment === (fragment || null))) list.push({ fragment: fragment ? decodeURIComponent(fragment) : null, title })
		titles.set(path, list)
	}
	const nav = [...manifest.values()].find((m) => m.props.split(/\s+/).includes('nav'))
	const navPath = nav && posix.join(opfDir, nav.href)
	if (navPath && files[navPath]) {
		const { document } = parseHTML(new TextDecoder().decode(files[navPath]))
		const toc = [...document.querySelectorAll('nav')].find((n) => /toc/.test(n.getAttribute('epub:type') ?? '')) ?? document.querySelector('nav')
		for (const a of toc?.querySelectorAll('a') ?? []) add(navPath, a.getAttribute('href'), clean(a.textContent))
	}
	const ncx = ncxId ? manifest.get(ncxId) : [...manifest.values()].find((m) => m.type === 'application/x-dtbncx+xml')
	const ncxPath = ncx && posix.join(opfDir, ncx.href)
	if (!titles.size && ncxPath && files[ncxPath]) {
		const doc = xml(new TextDecoder().decode(files[ncxPath]))
		for (const point of byLocalName(doc, 'navPoint')) {
			const label = byLocalName(point, 'text')[0]
			const content = byLocalName(point, 'content')[0]
			add(ncxPath, content?.getAttribute('src') ?? null, clean(label?.textContent))
		}
	}
	return titles
}

/**
 * Reads an EPUB in its reading order. Each chapter becomes a top-level section titled from the
 * table of contents, and its own headings nest below. Chapter XHTML goes through the same
 * conversion as web pages, so only text and the book's own images survive.
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
	const manifest = new Map(
		byLocalName(opf, 'item').map((i) => [i.getAttribute('id') ?? '', { href: i.getAttribute('href') ?? '', type: i.getAttribute('media-type') ?? '', props: i.getAttribute('properties') ?? '' }]),
	)
	const spineEl = byLocalName(opf, 'spine')[0]
	const spine = byLocalName(opf, 'itemref')
		.filter((r) => r.getAttribute('linear') !== 'no')
		.map((r) => manifest.get(r.getAttribute('idref') ?? ''))
		.filter((m) => m && /html/.test(m.type))
		.map((m) => posix.normalize(posix.join(opfDir, decodeURIComponent(m!.href))))
	const titles = tableOfContents(files, opfDir, manifest, spineEl?.getAttribute('toc') ?? null)
	const bookTitle = clean(byLocalName(opf, 'title')[0]?.textContent) || 'Untitled book'
	const author = clean(byLocalName(opf, 'creator')[0]?.textContent) || null

	const blocks: Block[] = []
	const images = new Map<string, Uint8Array>()
	for (const [n, path] of spine.entries()) {
		const html = text(path)
		if (!html) continue
		const { document } = parseHTML(html)
		// Mark where each chapter listed for this file starts, so one file can hold many chapters.
		const entries = titles.get(path) ?? []
		for (const entry of entries) {
			const target = entry.fragment && document.getElementById(entry.fragment)
			if (!target) continue
			const marker = document.createElement('h1')
			marker.textContent = `${CHAPTER}${entry.title}`
			target.parentNode?.insertBefore(marker, target)
		}
		const converted = htmlToBlocks(document.body as unknown as DomNode, `${EPUB_SCHEME}//book/${path}`, { imageSchemes: [EPUB_SCHEME] })
		// Text before the first marked chapter takes the file's own entry, or its first heading.
		const fileTitle = entries.find((e) => !e.fragment)?.title
		const chunks: { title: string | null; blocks: Block[] }[] = [{ title: fileTitle ?? null, blocks: [] }]
		for (const b of converted) {
			if (b.type === 'heading' && b.text.startsWith(CHAPTER)) chunks.push({ title: b.text.slice(CHAPTER.length), blocks: [] })
			else chunks.at(-1)!.blocks.push(b)
		}
		for (const chunk of chunks) {
			const chapter = chunk.blocks
			const pictures = chapter.filter((b) => b.type === 'image')
			// Covers, title pages, and copyright notices have almost no text.
			if (words(chapter) < 60 && !(pictures.length && words(chapter) > 0)) continue
			const firstHeading = chapter.find((b) => b.type === 'heading')
			const title = chunk.title || (firstHeading?.type === 'heading' ? firstHeading.text : '') || `Part ${n + 1}`
			// Project Gutenberg's front page and licence are not the book.
			if (/^the project gutenberg e(book|text)|project gutenberg.*licen[cs]e/i.test(title)) continue
			for (const b of pictures) {
				if (b.type !== 'image' || !b.src) continue
				const file = decodeURIComponent(new URL(b.src).pathname.replace(/^\//, ''))
				if (files[file]) images.set(b.src, files[file])
			}
			// The chapter's own top heading usually repeats its title.
			const headingAt = chapter.findIndex((b) => b.type !== 'image')
			const lead = chapter[headingAt]
			const body =
				lead?.type === 'heading' && (clean(lead.text).toLowerCase() === title.toLowerCase() || title.toLowerCase().includes(clean(lead.text).toLowerCase()))
					? chapter.filter((_, i) => i !== headingAt)
					: chapter
			const top = Math.min(6, ...body.flatMap((b) => (b.type === 'heading' ? [b.level] : [])))
			blocks.push({ type: 'heading', level: 1, text: title })
			for (const b of body) blocks.push(b.type === 'heading' ? { ...b, level: Math.min(6, 2 + b.level - top) } : b)
		}
	}
	if (!blocks.length) throw new ExtractError("This book has no text Life Log Club can read.")
	return { title: bookTitle.slice(0, 200), author: author?.slice(0, 200) ?? null, blocks, images }
}
