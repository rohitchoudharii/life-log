import type { Block } from '@peak/core'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import { db, t } from '../db'
import { parseBody, requireUser, type AppEnv } from '../http'
import { mediaStore, saveImage } from '../media'
import { decodeHtml, ExtractError, extractArticle } from '../web/extract'
import { FetchError, safeFetch } from '../web/fetch'
import { createItem, ItemPrefs, ownItem } from './library'

const MB = 1024 * 1024
const IMAGE_BYTES = 5 * MB
type ImageBlock = Extract<Block, { type: 'image' }>

async function imageBytes(src: string, referer: string): Promise<Buffer> {
	if (src.startsWith('data:')) {
		const bytes = Buffer.from(src.slice(src.indexOf(',') + 1), 'base64')
		if (bytes.length > IMAGE_BYTES) throw new FetchError('Image too large')
		return bytes
	}
	return (await safeFetch(src, { accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8', maxBytes: IMAGE_BYTES, timeoutMs: 10_000, referer })).body
}

/**
 * Downloads every image the page links to and stores our own copy. Images that fail stay as
 * blocks with no media id; their addresses come back as `missing` so the extension, which can
 * see them, may send the bytes itself.
 */
async function attachImages(userId: string, blocks: Block[], pageUrl: string) {
	const out: (Block | null)[] = [...blocks]
	const missing: string[] = []
	const todo = blocks.flatMap((b, i) => (b.type === 'image' && !b.mediaId && b.src ? [i] : []))
	for (let k = 0; k < todo.length; k += 4)
		await Promise.all(
			todo.slice(k, k + 4).map(async (i) => {
				const img = out[i] as ImageBlock
				const bytes = await imageBytes(img.src!, pageUrl).catch(() => null)
				// Not downloaded: the extension may be able to send it. Downloaded but unusable (an icon,
				// a tracking pixel, an SVG): it is not part of the article, so it goes.
				if (!bytes) {
					if (!img.src!.startsWith('data:')) missing.push(img.src!)
					return
				}
				const saved = await saveImage(userId, bytes)
				out[i] = saved && { ...img, mediaId: saved.id, width: saved.width, height: saved.height }
			}),
		)
	return { blocks: out.filter((b) => b !== null), missing: [...new Set(missing)] }
}

function failure(err: unknown): never {
	if (err instanceof FetchError || err instanceof ExtractError) throw new HTTPException(422, { message: err.message })
	throw err
}

export const web = new Hono<AppEnv>()
	.use(requireUser)
	// Paste a link: the server fetches the page and keeps its article.
	.post('/items/url', async (c) => {
		const { url, ...prefs } = await parseBody(c, ItemPrefs.extend({ url: z.string().trim().min(1, 'Paste a link').max(2000) }))
		const page = await safeFetch(/^https?:\/\//i.test(url) ? url : `https://${url}`, { accept: 'text/html,application/xhtml+xml', maxBytes: 5 * MB }).catch(failure)
		const type = page.contentType.split(';')[0]!.trim().toLowerCase()
		if (type === 'application/pdf') throw new HTTPException(422, { message: 'PDF links are not supported yet.' })
		if (type && type !== 'text/html' && type !== 'application/xhtml+xml') throw new HTTPException(422, { message: "That link isn't a web page" })
		let article
		try {
			article = extractArticle(decodeHtml(page.body, page.contentType), page.url)
		} catch (err) {
			failure(err)
		}
		const { blocks } = await attachImages(c.var.user.id, article.blocks, page.url)
		const item = await createItem(c.var.user.id, { title: article.title, source: 'url', sourceUrl: page.url, blocks, ...prefs })
		return c.json({ item }, 201)
	})
	// From the browser extension: the page as the user sees it, so pages behind a sign-in work too.
	.post('/items/capture', bodyLimit({ maxSize: 12 * MB, onError: () => { throw new HTTPException(413, { message: 'That page is too large to capture' }) } }), async (c) => {
		const { url, html, title, ...prefs } = await parseBody(
			c,
			ItemPrefs.extend({ url: z.url({ protocol: /^https?$/ }).max(2000), html: z.string().min(1).max(10 * MB), title: z.string().trim().max(200).optional() }),
		)
		let article
		try {
			article = extractArticle(html, url)
		} catch (err) {
			failure(err)
		}
		const { blocks, missing } = await attachImages(c.var.user.id, article.blocks, url)
		// Readability's title is the article's own; the tab title often adds the site's name.
		const item = await createItem(c.var.user.id, { title: article.title || title || url, source: 'web_capture', sourceUrl: url, blocks, ...prefs })
		return c.json({ item, missingImages: missing }, 201)
	})
	// Image bytes the extension fetched itself, for images the server could not download.
	.post('/items/:id/images', bodyLimit({ maxSize: 8 * MB, onError: () => { throw new HTTPException(413, { message: 'Image too large' }) } }), async (c) => {
		const item = await ownItem(c.var.user.id, c.req.param('id'))
		const { src, data } = await parseBody(c, z.object({ src: z.string().max(4000), data: z.base64().max(7 * MB) }))
		const sections = await db.select({ id: t.sections.id, blocks: t.sections.blocks }).from(t.sections).where(eq(t.sections.itemId, item.id))
		const waiting = sections.filter((s) => s.blocks.some((b) => b.type === 'image' && !b.mediaId && b.src === src))
		if (!waiting.length) throw new HTTPException(404, { message: 'No image with that address is waiting' })
		const saved = await saveImage(c.var.user.id, Buffer.from(data, 'base64'))
		if (!saved) throw new HTTPException(422, { message: "That isn't an image we can show" })
		for (const s of waiting)
			await db
				.update(t.sections)
				.set({ blocks: s.blocks.map((b) => (b.type === 'image' && !b.mediaId && b.src === src ? { ...b, mediaId: saved.id, width: saved.width, height: saved.height } : b)) })
				.where(eq(t.sections.id, s.id))
		return c.json({ mediaId: saved.id })
	})
	.get('/collections', async (c) => {
		const rows = await db.select().from(t.collections).where(eq(t.collections.userId, c.var.user.id)).orderBy(t.collections.createdAt)
		return c.json({ collections: rows.map(({ id, name }) => ({ id, name })) })
	})
	.post('/collections', async (c) => {
		const { name } = await parseBody(c, z.object({ name: z.string().trim().min(1, 'Name the bucket').max(100) }))
		const [row] = await db.insert(t.collections).values({ userId: c.var.user.id, name }).returning()
		return c.json({ collection: { id: row!.id, name: row!.name } }, 201)
	})
	.patch('/collections/:id', async (c) => {
		const { name } = await parseBody(c, z.object({ name: z.string().trim().min(1, 'Name the bucket').max(100) }))
		const [row] = await db
			.update(t.collections)
			.set({ name })
			.where(and(eq(t.collections.id, c.req.param('id')), eq(t.collections.userId, c.var.user.id)))
			.returning()
		if (!row) throw new HTTPException(404, { message: 'Not found' })
		return c.json({ collection: { id: row.id, name: row.name } })
	})
	// Deleting a bucket keeps its readings; they just leave the bucket.
	.delete('/collections/:id', async (c) => {
		await db.delete(t.collections).where(and(eq(t.collections.id, c.req.param('id')), eq(t.collections.userId, c.var.user.id)))
		return c.json({ ok: true })
	})
	// The bucket's readings in their new order. Every reading in it must be listed.
	.put('/collections/:id/order', async (c) => {
		const { itemIds } = await parseBody(c, z.object({ itemIds: z.array(z.uuid()).max(1000) }))
		await db.transaction(async (tx) => {
			const [owned] = await tx
				.select({ id: t.collections.id })
				.from(t.collections)
				.where(and(eq(t.collections.id, c.req.param('id')), eq(t.collections.userId, c.var.user.id)))
				.for('update')
			if (!owned) throw new HTTPException(404, { message: 'Not found' })
			const members = await tx.select({ id: t.contentItems.id }).from(t.contentItems).where(eq(t.contentItems.collectionId, owned.id))
			const ids = new Set(members.map((m) => m.id))
			if (ids.size !== itemIds.length || !itemIds.every((id) => ids.has(id))) throw new HTTPException(400, { message: 'List every reading in the bucket once' })
			for (const [position, id] of itemIds.entries()) await tx.update(t.contentItems).set({ collectionPosition: position }).where(eq(t.contentItems.id, id))
		})
		return c.json({ ok: true })
	})
	// Moves a reading into a bucket (at the end) or out of every bucket (null).
	.put('/items/:id/collection', async (c) => {
		const item = await ownItem(c.var.user.id, c.req.param('id'))
		const { collectionId } = await parseBody(c, z.object({ collectionId: z.uuid().nullable() }))
		await db.transaction(async (tx) => {
			let position: number | null = null
			if (collectionId) {
				const [owned] = await tx
					.select({ id: t.collections.id })
					.from(t.collections)
					.where(and(eq(t.collections.id, collectionId), eq(t.collections.userId, c.var.user.id)))
					.for('update')
				if (!owned) throw new HTTPException(404, { message: 'That bucket was not found' })
				const members = await tx.select({ p: t.contentItems.collectionPosition }).from(t.contentItems).where(eq(t.contentItems.collectionId, owned.id))
				position = Math.max(-1, ...members.map((m) => m.p ?? -1)) + 1
			}
			await tx.update(t.contentItems).set({ collectionId, collectionPosition: position }).where(eq(t.contentItems.id, item.id))
		})
		return c.json({ ok: true })
	})

/**
 * Images are public to whoever has the id: a browser cannot send our sign-in header with an
 * <img>, and ids are random UUIDs. The headers stop the bytes from ever being run as a page.
 */
export const mediaRoute = new Hono().get('/media/:id', async (c) => {
	const id = c.req.param('id')
	if (!z.uuid().safeParse(id).success) return c.notFound()
	const [row] = await db.select({ contentType: t.media.contentType }).from(t.media).where(eq(t.media.id, id))
	const bytes = row && (await mediaStore.get(id))
	if (!bytes) return c.notFound()
	return c.body(new Uint8Array(bytes), 200, {
		'content-type': row.contentType,
		'x-content-type-options': 'nosniff',
		'content-security-policy': "default-src 'none'; sandbox",
		'cross-origin-resource-policy': 'cross-origin',
		'cache-control': 'private, max-age=31536000, immutable',
	})
})
