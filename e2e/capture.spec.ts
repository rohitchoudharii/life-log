import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { ORPCError } from '@orpc/client'
import { expect, test } from '@playwright/test'
import { newMember } from './api'
import { FAKE_SITE, FAKE_SITE_PORT } from './env'

// What the extension sends: the page as the member's browser shows it, and the images it read.
const MEMBERS = `http://127.0.0.1:${FAKE_SITE_PORT}`
const chapterUrl = `${MEMBERS}/members/chapter-1`
const page = (signedIn: boolean) => fetch(chapterUrl, { headers: signedIn ? { cookie: 'member=1' } : {} }).then((r) => r.text())
const figure = () => new File([readFileSync(new URL('../apps/server/src/import/fixtures/figure.png', import.meta.url))], 'figure.png', { type: 'image/png' })

test.beforeEach(({}, info) => test.skip(info.project.name !== 'desktop', 'API only'))

test('a saved page is kept whole, with the images the tab read and the one the server fetched', async () => {
	const { client } = await newMember()
	const { reading, updated } = await client.readings.capture({
		id: randomUUID(),
		url: chapterUrl,
		html: await page(true),
		bookId: null,
		// The tab read the members' image and the lazy one with the site's cookie, and the CORS one.
		images: [`${MEMBERS}/members/figure.png`, `${MEMBERS}/members/lazy.png`, `${FAKE_SITE}/cdn/figure.png`].map((src) => ({ src, file: figure() })),
	})
	expect(updated).toBe(false)
	// The page says it is for subscribers, but the member saved it signed in: it is not refused.
	expect(reading).toMatchObject({ status: 'ready', source: 'web_capture', title: 'Chapter 1: Why the ring holds', readAt: null })
	const full = await client.readings.get({ id: reading.id })
	expect(full.contents.map((s) => s.title)).toEqual(['Keys on a ring', 'When a server leaves', 'What keeps it steady'])
	const blocks = (await Promise.all(full.contents.map((s) => client.readings.section({ id: s.id })))).flatMap((s) => s.blocks)
	const images = blocks.filter((b) => b.type === 'image')
	// All four are stored: the one from a CDN without CORS was fetched by the server.
	expect(images.map((b) => b.alt)).toEqual(['A ring of four servers', 'A lazy-loaded figure', 'A figure from a CDN that allows CORS', 'A figure from a CDN without CORS'])
	expect(images.every((b) => b.type === 'image' && b.mediaId)).toBe(true)
})

test('saving the same page again replaces it, resets it to not read, and keeps one reading', async () => {
	const { client } = await newMember()
	const first = await client.readings.capture({ id: randomUUID(), url: chapterUrl, html: await page(false), bookId: null, images: [] })
	const preview = await client.readings.get({ id: first.reading.id })
	await client.readings.markRead({ id: first.reading.id })
	expect((await client.readings.get({ id: first.reading.id })).readAt).not.toBeNull()

	const again = await client.readings.capture({ id: randomUUID(), url: `${chapterUrl}?utm_source=mail`, html: await page(true), bookId: null, images: [] })
	expect(again).toMatchObject({ updated: true, reading: { id: first.reading.id, readAt: null } })
	expect(again.reading.wordCount).toBeGreaterThan(preview.wordCount * 10)
	expect((await client.readings.list()).map((r) => r.id)).toEqual([first.reading.id])
	// The images it had no bytes for keep their descriptions, and the one on a public CDN is fetched.
	const blocks = (await client.readings.section({ id: (await client.readings.get({ id: first.reading.id })).contents[0]!.id })).blocks
	expect(blocks.find((b) => b.type === 'image')).toEqual({ type: 'image', mediaId: null, alt: 'A ring of four servers' })
})

test('the picker offers the page’s own book, else the last book used on the same site', async () => {
	const { client } = await newMember()
	expect(await client.readings.captureTarget({ url: chapterUrl })).toEqual({ readingId: null, words: null, book: null, bookWords: null })
	const book = await client.books.create({ id: randomUUID(), title: "The Members' Book" })
	const { reading } = await client.readings.capture({ id: randomUUID(), url: chapterUrl, html: await page(true), bookId: book.id, images: [] })
	expect((await client.books.get({ id: book.id })).chapters.map((c) => c.id)).toEqual([reading.id])
	expect(await client.readings.captureTarget({ url: chapterUrl })).toEqual({
		readingId: reading.id,
		words: reading.wordCount,
		book: { id: book.id, title: "The Members' Book" },
		bookWords: reading.wordCount,
	})
	// A new page on the same site gets the same book; another site gets none.
	expect((await client.readings.captureTarget({ url: `${MEMBERS}/members/chapter-2` })).book).toEqual({ id: book.id, title: "The Members' Book" })
	expect((await client.readings.captureTarget({ url: 'https://example.com/post' })).book).toBeNull()
	// Saving with No book takes the page out of its book.
	await client.readings.capture({ id: randomUUID(), url: chapterUrl, html: await page(true), bookId: null, images: [] })
	expect((await client.books.get({ id: book.id })).chapters).toEqual([])
})

test('a saved page refuses what it should, with a message', async () => {
	const { client } = await newMember()
	const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e instanceof ORPCError ? `${e.code}: ${e.message}` : String(e)))
	expect(await code(client.readings.capture({ id: randomUUID(), url: 'notes', html: '<p>x</p>', bookId: null, images: [] }))).toBe(
		"BAD_REQUEST: That isn't a web address. Check the link and try again.",
	)
	expect(await code(client.readings.capture({ id: randomUUID(), url: `${MEMBERS}/empty`, html: '<html><body></body></html>', bookId: null, images: [] }))).toBe(
		"BAD_REQUEST: We couldn't find an article on this page.",
	)
	// Another member's book is out of reach.
	const other = await newMember('B')
	const theirs = await other.client.books.create({ id: randomUUID(), title: 'Theirs' })
	expect(await code(client.readings.capture({ id: randomUUID(), url: chapterUrl, html: await page(true), bookId: theirs.id, images: [] }))).toMatch(/^NOT_FOUND/)
	expect(await client.readings.list()).toEqual([])
})
