import { randomUUID } from 'node:crypto'
import { type Block, blockText, countWords, hasHeadings, type SectionDraft, splitSections } from '@life-log-club/domain'
import { and, eq, isNull, ne } from 'drizzle-orm'
import { asUser } from '../db/client'
import { media, readingFiles, readings, sections } from '../db/schema'
import { bookKind, parseBook } from './book'
import { decodeHtml, ExtractError, extractArticle, SIGN_IN } from './extract'
import { FetchError, safeFetch, TOO_LARGE } from './fetch'
import { addAiHeadings } from './headings'
import { type PreparedImage, prepareImage } from './media'

/** Sent when no other message fits, such as a bug; the member can only try again. */
export const UNEXPECTED = 'Something went wrong while adding this page. Try again in a minute.'

export const NOT_A_LINK = "That isn't a web address. Check the link and try again."
export const NOT_A_BOOK = 'Life Log Club reads EPUB and PDF files. Choose one of those.'
const MAX_SECTIONS = 2000
/** An article this long with no headings gets AI headings; a shorter one is one section (issue #1). */
const AI_HEADINGS_MIN_WORDS = 1000
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

/** Fetches the page and finds its article. Throws FetchError or ExtractError with a message for the member. */
async function readPage(url: string) {
	const page = (await arxivHtml(url)) ?? (await safeFetch(url, { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' }))
	if (page.url !== url && SIGN_IN_PATH.test(new URL(page.url).pathname)) throw new ExtractError(SIGN_IN)
	const type = page.contentType.split(';')[0]!.trim().toLowerCase()
	if (type === 'application/pdf' || page.body.subarray(0, 5).toString('latin1') === '%PDF-')
		throw new ExtractError('This link is a PDF. PDF links come soon; for now, download it and add the file later.')
	if (type && type !== 'text/html' && type !== 'application/xhtml+xml')
		throw new ExtractError("This link isn't a web page. Check the link and try again.")
	const article = extractArticle(decodeHtml(page.body, page.contentType), page.url)
	return { article, sourceUrl: article.canonicalUrl ?? normaliseUrl(page.url) ?? page.url }
}

/** What every source turns into before it is stored: the same shape for links and files. */
type Imported = {
	title: string
	author: string | null
	publishedAt: Date | null
	/** Links only: the page's own address, used to find the same page under another link. */
	sourceUrl: string | null
	blocks: Block[]
	/** Re-encoded images, by the id their image blocks now point at. */
	images: Map<string, PreparedImage>
}

async function readLink(userId: string, url: string): Promise<Imported> {
	const { article, sourceUrl } = await readPage(url)
	const words = article.blocks.reduce((n, b) => n + countWords(blockText(b)), 0)
	const blocks = !hasHeadings(article.blocks) && words >= AI_HEADINGS_MIN_WORDS ? await addAiHeadings(userId, article.blocks) : article.blocks
	return { ...article, sourceUrl, blocks, images: new Map() }
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
	const blocks = book.blocks.flatMap((b): Block[] => {
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
	})
	return { title: book.title, author: book.author, publishedAt: null, sourceUrl: null, blocks, images }
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
	let drafts: SectionDraft[]
	try {
		imported = reading.source === 'url' ? await readLink(userId, reading.requestedUrl!) : await readFile(userId, readingId)
		drafts = splitSections(imported.blocks, imported.title)
		if (drafts.length > MAX_SECTIONS) throw new ExtractError(TOO_LARGE)
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
		await tx.insert(sections).values(
			drafts.map((s, position) => ({
				userId,
				readingId,
				position,
				level: s.level,
				title: s.title.slice(0, 300),
				blocks: s.blocks,
				wordCount: s.wordCount,
				aiTitle: s.aiTitle,
			})),
		)
		await tx
			.update(readings)
			.set({
				status: 'ready',
				error: null,
				title: imported.title,
				author: imported.author,
				publishedAt: imported.publishedAt,
				sourceUrl,
				wordCount: drafts.reduce((n, s) => n + s.wordCount, 0),
			})
			.where(eq(readings.id, readingId))
	})
}

function fail(userId: string, readingId: string, error: string) {
	return asUser(userId, (tx) =>
		tx
			.update(readings)
			.set({ status: 'failed', error })
			.where(and(eq(readings.id, readingId), eq(readings.status, 'importing'))),
	)
}
