import type { Block } from '@life-log-club/core'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { HTTPException } from 'hono/http-exception'
import { readEpub } from '../books/epub'
import { readPdf } from '../books/pdf'
import { requireUser, type AppEnv } from '../http'
import { saveImage } from '../media'
import { ExtractError } from '../web/extract'
import { createItem, ItemPrefs } from './library'

const MB = 1024 * 1024
export const MAX_BOOK_BYTES = 50 * MB

export const isPdf = (bytes: Uint8Array) => bytes.length > 4 && new TextDecoder().decode(bytes.subarray(0, 5)) === '%PDF-'
const isZip = (bytes: Uint8Array) => bytes[0] === 0x50 && bytes[1] === 0x4b

/** Stores a book's own images and points its image blocks at them; images that are not usable go. */
async function storeBookImages(userId: string, blocks: Block[], images: Map<string, Uint8Array>): Promise<Block[]> {
	const saved = new Map<string, Awaited<ReturnType<typeof saveImage>>>()
	const srcs = [...images.keys()]
	for (let k = 0; k < srcs.length; k += 4)
		await Promise.all(srcs.slice(k, k + 4).map(async (src) => saved.set(src, await saveImage(userId, Buffer.from(images.get(src)!)))))
	return blocks.flatMap((b): Block[] => {
		if (b.type !== 'image') return [b]
		const img = b.src ? saved.get(b.src) : null
		return img ? [{ ...b, mediaId: img.id, width: img.width, height: img.height }] : []
	})
}

export const books = new Hono<AppEnv>()
	.use(requireUser)
	// An EPUB or PDF from the user's device. The file type comes from its bytes, not its name.
	.post(
		'/items/upload',
		bodyLimit({ maxSize: MAX_BOOK_BYTES + MB, onError: () => { throw new HTTPException(413, { message: 'That file is larger than 50 MB' }) } }),
		async (c) => {
			const form = await c.req.parseBody()
			const file = form.file
			if (!(file instanceof File)) throw new HTTPException(400, { message: 'Choose an EPUB or PDF file' })
			const prefs = ItemPrefs.parse({ collectionId: form.collectionId || undefined })
			const bytes = new Uint8Array(await file.arrayBuffer())
			const name = file.name.replace(/\.(epub|pdf)$/i, '') || 'Untitled'
			try {
				if (isPdf(bytes)) {
					const pdf = await readPdf(bytes, name)
					return c.json({ item: await createItem(c.var.user.id, { ...pdf, source: 'pdf_upload', ...prefs }) }, 201)
				}
				if (isZip(bytes)) {
					const book = readEpub(bytes)
					const blocks = await storeBookImages(c.var.user.id, book.blocks, book.images)
					return c.json({ item: await createItem(c.var.user.id, { title: book.title, blocks, source: 'epub', ...prefs }) }, 201)
				}
			} catch (err) {
				if (err instanceof ExtractError) throw new HTTPException(422, { message: err.message })
				throw err
			}
			throw new HTTPException(415, { message: 'Life Log Club reads EPUB and PDF files' })
		},
	)
