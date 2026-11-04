import { subtreeEnd, type Block } from '@peak/core'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import { readEpub } from '../books/epub'
import { readPdf } from '../books/pdf'
import { db, t } from '../db'
import { parseBody, requireUser, type AppEnv } from '../http'
import { enqueueGeneration } from '../jobs'
import { saveImage } from '../media'
import { ExtractError } from '../web/extract'
import { createItem, ItemPrefs, ownItem } from './library'

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
			const prefs = ItemPrefs.parse({
				questionIntensity: form.questionIntensity || undefined,
				questionStyle: form.questionStyle || undefined,
				collectionId: form.collectionId || undefined,
			})
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
			throw new HTTPException(415, { message: 'Peak reads EPUB and PDF files' })
		},
	)
	// Questions for the chapters the user wants to be tested on. A picked section brings its whole
	// chapter, so the chapter's questions are written together and can link its parts.
	.post('/items/:id/prepare', async (c) => {
		const item = await ownItem(c.var.user.id, c.req.param('id'))
		const { sectionIds } = await parseBody(c, z.object({ sectionIds: z.array(z.uuid()).min(1).max(2000) }))
		const all = await db
			.select({ id: t.sections.id, level: t.sections.level })
			.from(t.sections)
			.where(eq(t.sections.itemId, item.id))
			.orderBy(asc(t.sections.position))
		const levels = all.map((s) => s.level)
		const wanted = new Set<string>()
		for (const id of sectionIds) {
			let start = all.findIndex((s) => s.id === id)
			if (start < 0) continue
			while (start > 0 && all[start]!.level > 1) start--
			for (let i = start; i < subtreeEnd(levels, start); i++) wanted.add(all[i]!.id)
		}
		if (!wanted.size) throw new HTTPException(400, { message: 'Pick sections of this reading' })
		await db
			.update(t.sections)
			.set({ questionsWanted: true })
			.where(and(eq(t.sections.itemId, item.id), inArray(t.sections.id, [...wanted])))
		await db.update(t.contentItems).set({ status: 'processing', error: null }).where(eq(t.contentItems.id, item.id))
		await enqueueGeneration(item.id)
		return c.json({ sections: wanted.size })
	})
