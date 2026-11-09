import { randomUUID } from 'node:crypto'
import { MAX_FILE_BYTES } from '@life-log-club/contract'
import {
	ARTICLE_HEADINGS_MIN_WORDS,
	type Block,
	type BookSection,
	blockText,
	type Chapter,
	countWords,
	hasHeadings,
	splitBook,
	splitSections,
} from '@life-log-club/domain'
import { and, asc, eq, gt, inArray, isNull, lt, ne, sql } from 'drizzle-orm'
import { asUser } from '../db/client'
import { media, readingFiles, readings, sections } from '../db/schema'
import { type Book, bookKind, parseBook } from './book'
import { decodeHtml, ExtractError, extractArticle, SIGN_IN } from './extract'
import { FetchError, safeFetch, TOO_LARGE } from './fetch'
import { addAiHeadings } from './headings'
import { type PreparedImage, prepareImage } from './media'

/** Sent when no other message fits, such as a bug; the member can only try again. */
export const UNEXPECTED = 'Something went wrong while adding this page. Try again in a minute.'

export const NOT_A_LINK = "That isn't a web address. Check the link and try again."
export const NOT_A_BOOK = 'Life Log Club reads EPUB and PDF files. Choose one of those.'
const MAX_SECTIONS = 2000
const MAX_HTML_BYTES = 5 * 1024 * 1024
const TRACKING = /^(utm_\w+|fbclid|gclid|mc_cid|mc_eid)$/i

/**
 * The address a member means by what they pasted: https when they gave no scheme, the host in
 * lower case, without the #fragment, the default port, or tracking parameters. Two pastes of
 * the same page from different newsletters give the same address. Returns null for text that
 * isn't a web address.
 */
export function normaliseUrl(input: string): string | null {
	const text = input.trim()
	let url: URL
	try {
		url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(text) ? text : `https://${text}`)
	} catch {
		return null
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
	// "notes" or "hello world" would be looked up as a host name; only real hosts are links.
	if (!url.hostname.includes('.') && !url.hostname.startsWith('[') && url.hostname !== 'localhost') return null
	url.hash = ''
	for (const key of [...url.searchParams.keys()]) if (TRACKING.test(key)) url.searchParams.delete(key)
	return url.href
}

/** Where a site sends someone who is not signed in. */
const SIGN_IN_PATH = /\/(log-?in|sign-?in|sign-?up|register|auth|sso|account\/login)(\/|$)/i

/** arXiv papers have an HTML version that keeps math as text; a link to the abstract or PDF uses it when there is one. */
async function arxivHtml(url: string) {
	const m = /^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\/([\w./-]+?\d(?:v\d+)?)(?:\.pdf)?\/?$/i.exec(url)
	if (!m) return null
	return safeFetch(`https://arxiv.org/html/${m[1]}`, { accept: 'text/html' }).catch(() => null)
}

/**
 * Fetches the page and finds its article, or the PDF the link points at. Throws FetchError or
 * ExtractError with a message for the member.
 */
async function readPage(url: string) {
	// A PDF can be as large as an uploaded file, and takes longer to arrive than a page.
	const page =
		(await arxivHtml(url)) ??
		(await safeFetch(url, { accept: 'text/html,application/xhtml+xml;q=0.9,application/pdf;q=0.8,*/*;q=0.5', maxBytes: MAX_FILE_BYTES, timeoutMs: 60_000 }))
	if (page.url !== url && SIGN_IN_PATH.test(new URL(page.url).pathname)) throw new ExtractError(SIGN_IN)
	const type = page.contentType.split(';')[0]!.trim().toLowerCase()
	const finalUrl = normaliseUrl(page.url) ?? page.url
	if (type === 'application/pdf' || bookKind(page.body) === 'pdf') return { pdf: new Uint8Array(page.body), sourceUrl: finalUrl } as const
	if (type && type !== 'text/html' && type !== 'application/xhtml+xml')
		throw new ExtractError("This link isn't a web page. Check the link and try again.")
	if (page.body.length > MAX_HTML_BYTES) throw new ExtractError(TOO_LARGE)
	const article = extractArticle(decodeHtml(page.body, page.contentType), page.url)
	return { article, sourceUrl: article.canonicalUrl ?? finalUrl } as const
}

/** What every source turns into before it is stored: the same shape for links and files. */
type Imported = {
	title: string
	author: string | null
	publishedAt: Date | null
	/** Links only: the page's own address, used to find the same page under another link. */
	sourceUrl: string | null
	/** Set when a link turned out to be a PDF. */
	source?: 'pdf_url'
	sections: BookSection[]
	/** Re-encoded images, by the id their image blocks now point at. */
	images: Map<string, PreparedImage>
}

const asArticle = (blocks: Block[], title: string): BookSection[] =>
	splitSections(blocks, title).map((s) => ({ ...s, chapter: 0, headingsPending: false, notes: [] }))

/**
 * A book's sections. Long chapters with no headings are only cut by length here; the AI adds
 * their headings when the member first opens one (see addChapterHeadings), so a long novel
 * doesn't cost an AI call for every chapter the member may never read.
 */
const bookSections = (book: Pick<Book, 'chapters' | 'article' | 'notes'>) =>
	splitBook(book.chapters, { notes: book.notes, ...(book.article && { headingsFrom: ARTICLE_HEADINGS_MIN_WORDS }) })

async function readLink(userId: string, url: string): Promise<Imported> {
	const page = await readPage(url)
	if (page.pdf) {
		const name = decodeURIComponent(new URL(page.sourceUrl).pathname.split('/').pop() ?? '').replace(/\.pdf$/i, '') || new URL(page.sourceUrl).hostname
		const book = await parseBook('pdf', page.pdf, name)
		return { ...book, publishedAt: null, sourceUrl: page.sourceUrl, source: 'pdf_url', sections: bookSections(book), images: new Map() }
	}
	const { article, sourceUrl } = page
	const words = article.blocks.reduce((n, b) => n + countWords(blockText(b)), 0)
	const blocks = !hasHeadings(article.blocks) && words >= ARTICLE_HEADINGS_MIN_WORDS ? await addAiHeadings(userId, article.blocks) : article.blocks
	return { ...article, sourceUrl, sections: asArticle(blocks, article.title), images: new Map() }
}

const IMAGE_BATCH = 4

/** Reads the member's uploaded file, and re-encodes the book's own images for the reader. */
async function readFile(userId: string, readingId: string): Promise<Imported> {
	const [file] = await asUser(userId, (tx) => tx.select().from(readingFiles).where(eq(readingFiles.readingId, readingId)))
	const kind = file && bookKind(file.data)
	if (!kind) throw new ExtractError(NOT_A_BOOK)
	const book = await parseBook(kind, new Uint8Array(file.data), file.name.replace(/\.(epub|pdf)$/i, '') || 'Untitled')
	const prepared = new Map<string, PreparedImage | null>()
	for (let k = 0; k < book.images.length; k += IMAGE_BATCH)
		await Promise.all(book.images.slice(k, k + IMAGE_BATCH).map(async ([src, bytes]) => prepared.set(src, await prepareImage(bytes))))
	const images = new Map<string, PreparedImage>()
	const ids = new Map<string, string>()
	const withImages = (b: Block): Block[] => {
		if (b.type !== 'image') return [b]
		const image = b.src ? prepared.get(b.src) : null
		// An image that can't be shown (an icon, an SVG) keeps its description, if it has one.
		if (!image) return b.alt ? [{ type: 'image', mediaId: null, alt: b.alt }] : []
		let id = ids.get(b.src!)
		if (!id) {
			id = randomUUID()
			ids.set(b.src!, id)
			images.set(id, image)
		}
		return [{ type: 'image', mediaId: id, alt: b.alt, width: image.width, height: image.height }]
	}
	const chapters: Chapter[] = book.chapters.map((c) => ({ ...c, blocks: c.blocks.flatMap(withImages) }))
	return { title: book.title, author: book.author, publishedAt: null, sourceUrl: null, sections: bookSections({ ...book, chapters }), images }
}

/**
 * The import job for one reading: reads the link's page or the uploaded file, splits it into
 * sections, and stores them with its images, all as the member who added it. A long article with
 * no headings first gets headings from the member's AI, when they have a key. Safe to run again:
 * a reading that is no longer importing is left alone, and its sections and images are stored in
 * the same transaction that sets it ready. When a link turns out to be a page the member already
 * has under another link, this reading is merged into that one instead of storing a copy.
 *
 * A failure the site may get over (no answer, a 5xx) is thrown so the job is retried, until
 * `lastTry`; every other failure marks the reading failed with its message.
 */
export async function importReading({ readingId, userId }: { readingId: string; userId: string }, lastTry = true) {
	const [reading] = await asUser(userId, (tx) => tx.select().from(readings).where(eq(readings.id, readingId)))
	if (reading?.status !== 'importing') return

	let imported: Imported
	try {
		imported = reading.requestedUrl ? await readLink(userId, reading.requestedUrl) : await readFile(userId, readingId)
		if (imported.sections.length > MAX_SECTIONS) throw new ExtractError(TOO_LARGE)
	} catch (error) {
		const known = error instanceof FetchError || error instanceof ExtractError
		if (!lastTry && (!known || (error instanceof FetchError && error.retry))) throw error
		if (!known) console.error('[import-reading]', readingId, error)
		await fail(userId, readingId, known ? error.message : UNEXPECTED)
		return
	}
	const { sourceUrl } = imported

	await asUser(userId, async (tx) => {
		const [current] = await tx.select().from(readings).where(eq(readings.id, readingId)).for('update')
		if (current?.status !== 'importing') return
		const [same] = sourceUrl
			? await tx
					.select({ id: readings.id })
					.from(readings)
					.where(
						and(
							eq(readings.sourceUrl, sourceUrl),
							ne(readings.id, readingId),
							eq(readings.status, 'ready'),
							isNull(readings.mergedInto),
							isNull(readings.deletedAt),
						),
					)
					.limit(1)
			: []
		if (same) {
			await tx.update(readings).set({ status: 'ready', sourceUrl, mergedInto: same.id }).where(eq(readings.id, readingId))
			return
		}
		if (imported.images.size)
			await tx.insert(media).values(
				[...imported.images].map(([id, image]) => ({
					id,
					userId,
					readingId,
					contentType: 'image/webp',
					bytes: image.data.length,
					width: image.width,
					height: image.height,
					data: image.data,
				})),
			)
		await tx.insert(sections).values(imported.sections.map((s, position) => sectionRow(userId, readingId, position, s)))
		await tx
			.update(readings)
			.set({
				status: 'ready',
				error: null,
				title: imported.title,
				author: imported.author,
				publishedAt: imported.publishedAt,
				sourceUrl,
				...(imported.source && { source: imported.source }),
				wordCount: imported.sections.reduce((n, s) => n + s.wordCount, 0),
			})
			.where(eq(readings.id, readingId))
	})
}

/**
 * Adds AI headings to one long chapter with none, when the member first opens it (issue #2,
 * rule 4), and replaces the chapter's length-cut parts with sections split at those headings.
 * The first section keeps its id, so a reader that has it open stays in place; the sections
 * after the chapter move along. Without a key, or when the AI fails, the length cut stays. Safe
 * to run twice: it does nothing once the chapter's headings are no longer pending, or when its
 * sections changed while the AI was answering.
 */
export async function addChapterHeadings({ userId, readingId, chapter }: { userId: string; readingId: string; chapter: number }) {
	const pending = and(eq(sections.readingId, readingId), eq(sections.chapter, chapter), eq(sections.headingsPending, true))
	const parts = await asUser(userId, (tx) => tx.select().from(sections).where(pending).orderBy(asc(sections.position)))
	const first = parts[0]
	if (!first) return
	const blocks = parts.flatMap((p) => p.blocks)
	const withHeadings = await addAiHeadings(userId, blocks)
	// The chapter's own title names its opening. An AI heading there would leave the section the
	// member has open with no text, and move what they were reading to the next one.
	if (withHeadings[0]?.type === 'heading') withHeadings.shift()
	const replaced =
		withHeadings === blocks
			? null
			: splitBook([{ title: first.title, level: first.level, kind: 'body', blocks: withHeadings }], { notes: parts.flatMap((p) => p.notes) }).map((s) => ({
					...s,
					chapter,
					headingsPending: false,
				}))

	await asUser(userId, async (tx) => {
		// One change to a reading's sections at a time.
		await tx.select({ id: readings.id }).from(readings).where(eq(readings.id, readingId)).for('update')
		const current = await tx.select({ id: sections.id }).from(sections).where(pending).orderBy(asc(sections.position))
		if (current.map((c) => c.id).join() !== parts.map((p) => p.id).join()) return
		const ids = parts.map((p) => p.id)
		if (!replaced) {
			await tx.update(sections).set({ headingsPending: false }).where(inArray(sections.id, ids))
			return
		}
		const last = parts.at(-1)!.position
		const shift = replaced.length - parts.length
		await tx.delete(sections).where(inArray(sections.id, ids.slice(1)))
		if (shift) {
			// Positions are unique at every row, so the later sections step out of the way first.
			const later = and(eq(sections.readingId, readingId), gt(sections.position, last))
			await tx.update(sections).set({ position: sql`-${sections.position} - 1` }).where(later)
			await tx
				.update(sections)
				.set({ position: sql`-${sections.position} - 1 + ${shift}` })
				.where(and(eq(sections.readingId, readingId), lt(sections.position, 0)))
		}
		await tx.update(sections).set(sectionRow(userId, readingId, first.position, replaced[0]!)).where(eq(sections.id, first.id))
		if (replaced.length > 1) await tx.insert(sections).values(replaced.slice(1).map((s, k) => sectionRow(userId, readingId, first.position + 1 + k, s)))
	})
}

/** The row for a section at `position` in its reading. */
const sectionRow = (userId: string, readingId: string, position: number, s: BookSection) => ({
	userId,
	readingId,
	position,
	level: s.level,
	title: s.title.slice(0, 300),
	blocks: s.blocks,
	wordCount: s.wordCount,
	aiTitle: s.aiTitle,
	kind: s.kind,
	chapter: s.chapter,
	headingsPending: s.headingsPending,
	notes: s.notes,
})

function fail(userId: string, readingId: string, error: string) {
	return asUser(userId, (tx) =>
		tx
			.update(readings)
			.set({ status: 'failed', error })
			.where(and(eq(readings.id, readingId), eq(readings.status, 'importing'))),
	)
}
