import { MAX_CAPTURE_IMAGE_BYTES } from '@life-log-club/contract'
import { ARTICLE_HEADINGS_MIN_WORDS, type BookSection, blockText, countWords, hasHeadings, splitSections } from '@life-log-club/domain'
import { ExtractError, extractArticle } from './extract'
import { safeFetch } from './fetch'
import { type PreparedImage, prepareImages } from './media'
import { NOT_A_LINK, normaliseUrl } from './reading'

const DATA_URL = /^data:image\/[\w+.-]+;base64,(.*)$/is

/**
 * An image the member's tab couldn't read, such as one on a CDN that sends no CORS headers: the
 * server fetches it once, as for any public address, without the member's cookies.
 */
async function fetchImage(src: string): Promise<Uint8Array | null> {
	const data = DATA_URL.exec(src)
	if (data) return Buffer.from(data[1]!, 'base64')
	try {
		return (await safeFetch(src, { accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,*/*;q=0.5', maxBytes: MAX_CAPTURE_IMAGE_BYTES, timeoutMs: 10_000 })).body
	} catch {
		return null
	}
}

export type Captured = {
	url: string
	title: string
	author: string | null
	publishedAt: Date | null
	/** The page's canonical address on the same site, else the address it was saved from. */
	sourceUrl: string
	sections: BookSection[]
	wordCount: number
	images: Map<string, PreparedImage>
}

/**
 * Reads a page the extension saved from the member's browser: the same extraction as a link
 * (Readability, then the allowlist that keeps only text, links and images), without the sign-in
 * refusals, since the member is signed in. Images come from the bytes the tab read, by the address
 * they load from, else from the server. A long article with no headings gets AI headings when it
 * is first opened. Throws ExtractError with a message for the member.
 */
export async function readCapture({ url: pasted, html, images }: { url: string; html: string; images: { src: string; file: File }[] }): Promise<Captured> {
	const url = normaliseUrl(pasted)
	if (!url) throw new ExtractError(NOT_A_LINK)
	const article = extractArticle(html, url, { captured: true })
	const uploaded = new Map(await Promise.all(images.map(async (i) => [i.src, new Uint8Array(await i.file.arrayBuffer())] as const)))
	const srcs = article.blocks.flatMap((b) => (b.type === 'image' && b.src ? [b.src] : []))
	const prepared = await prepareImages(srcs, (src) => uploaded.get(src) ?? fetchImage(src))
	const blocks = article.blocks.flatMap(prepared.withImages)
	const wordCount = blocks.reduce((n, b) => n + countWords(blockText(b)), 0)
	const headingsPending = !hasHeadings(blocks) && wordCount >= ARTICLE_HEADINGS_MIN_WORDS
	return {
		url,
		title: article.title,
		author: article.author,
		publishedAt: article.publishedAt,
		sourceUrl: article.canonicalUrl ?? url,
		sections: splitSections(blocks, article.title).map((s) => ({ ...s, chapter: 0, headingsPending, notes: [] })),
		wordCount,
		images: prepared.images,
	}
}
