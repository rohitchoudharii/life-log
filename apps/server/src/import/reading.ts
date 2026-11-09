import { splitSections } from '@life-log-club/domain'
import { and, eq, isNull, ne } from 'drizzle-orm'
import { asUser } from '../db/client'
import { readings, sections } from '../db/schema'
import { decodeHtml, ExtractError, extractArticle, SIGN_IN } from './extract'
import { FetchError, safeFetch, TOO_LARGE } from './fetch'

/** Sent when no other message fits, such as a bug; the member can only try again. */
export const UNEXPECTED = 'Something went wrong while adding this page. Try again in a minute.'

export const NOT_A_LINK = "That isn't a web address. Check the link and try again."
const MAX_SECTIONS = 2000
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

/** Fetches the page and turns it into sections. Throws FetchError or ExtractError with a message for the member. */
async function readPage(url: string) {
	const page = (await arxivHtml(url)) ?? (await safeFetch(url, { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' }))
	if (page.url !== url && SIGN_IN_PATH.test(new URL(page.url).pathname)) throw new ExtractError(SIGN_IN)
	const type = page.contentType.split(';')[0]!.trim().toLowerCase()
	if (type === 'application/pdf' || page.body.subarray(0, 5).toString('latin1') === '%PDF-')
		throw new ExtractError('This link is a PDF. PDF links come soon; for now, download it and add the file later.')
	if (type && type !== 'text/html' && type !== 'application/xhtml+xml')
		throw new ExtractError("This link isn't a web page. Check the link and try again.")
	const article = extractArticle(decodeHtml(page.body, page.contentType), page.url)
	const drafts = splitSections(article.blocks, article.title)
	if (drafts.length > MAX_SECTIONS) throw new ExtractError(TOO_LARGE)
	return { article, drafts, sourceUrl: article.canonicalUrl ?? normaliseUrl(page.url) ?? page.url }
}

/**
 * The import job for one link: fetches the page, finds its article, splits it into sections,
 * and stores them, all as the member who added it. Safe to run again: a reading that is no
 * longer importing is left alone, and its sections are stored in the same transaction that sets
 * it ready. When the page turns out to be one the member already has under another link, this
 * reading is merged into that one instead of storing a copy.
 *
 * A failure the site may get over (no answer, a 5xx) is thrown so the job is retried, until
 * `lastTry`; every other failure marks the reading failed with its message.
 */
export async function importReading({ readingId, userId }: { readingId: string; userId: string }, lastTry = true) {
	const [reading] = await asUser(userId, (tx) => tx.select().from(readings).where(eq(readings.id, readingId)))
	if (!reading?.requestedUrl || reading.status !== 'importing') return

	let page
	try {
		page = await readPage(reading.requestedUrl)
	} catch (error) {
		const known = error instanceof FetchError || error instanceof ExtractError
		if (!lastTry && (!known || (error instanceof FetchError && error.retry))) throw error
		if (!known) console.error('[import-reading]', readingId, error)
		await fail(userId, readingId, known ? error.message : UNEXPECTED)
		return
	}
	const { article, drafts, sourceUrl } = page

	await asUser(userId, async (tx) => {
		const [current] = await tx.select().from(readings).where(eq(readings.id, readingId)).for('update')
		if (current?.status !== 'importing') return
		const [same] = await tx
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
		if (same) {
			await tx.update(readings).set({ status: 'ready', sourceUrl, mergedInto: same.id }).where(eq(readings.id, readingId))
			return
		}
		await tx.insert(sections).values(
			drafts.map((s, position) => ({
				userId,
				readingId,
				position,
				level: s.level,
				title: s.title.slice(0, 300),
				blocks: s.blocks,
				wordCount: s.wordCount,
			})),
		)
		await tx
			.update(readings)
			.set({
				status: 'ready',
				error: null,
				title: article.title,
				author: article.author,
				publishedAt: article.publishedAt,
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
