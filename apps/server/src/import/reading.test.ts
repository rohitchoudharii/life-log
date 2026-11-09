import { randomUUID } from 'node:crypto'
import { asc, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { asUser, ownerDb, ownerPool, pool } from '../db/client'
import { prepareDatabase } from '../db/prepare'
import { readings, sections, users } from '../db/schema'
import { importReading, normaliseUrl } from './reading'
import { fixture, TEST_SITE, testSite } from './test-site'

const site = testSite()
beforeAll(async () => {
	await prepareDatabase()
	await site.start()
})
afterAll(() => Promise.all([site.stop(), pool.end(), ownerPool.end()]))

async function member() {
	const [user] = await ownerDb
		.insert(users)
		.values({ email: `reader-${randomUUID()}@example.com`, name: 'R' })
		.returning()
	return user!.id
}

/** Adds a link as the route does, then runs its import job. */
async function add(userId: string, url: string, lastTry = true) {
	const id = randomUUID()
	await asUser(userId, (tx) => tx.insert(readings).values({ id, userId, title: 'x', source: 'url', requestedUrl: url }))
	await importReading({ readingId: id, userId }, lastTry)
	return id
}

/** A small article page, with `head` added to its <head>. */
const article = (head: string) => ({
	body: `<html><head><title>Rings</title>${head}</head><body><article><h1>Rings</h1>${Array.from({ length: 12 }, (_, i) => `<p>Sentence ${i} about how consistent hashing spreads keys across a ring of servers.</p>`).join('')}</article></body></html>`,
	headers: { 'content-type': 'text/html; charset=utf-8' },
})

const load = (userId: string, id: string) =>
	asUser(userId, async (tx) => ({
		reading: (await tx.select().from(readings).where(eq(readings.id, id)))[0]!,
		sections: await tx.select().from(sections).where(eq(sections.readingId, id)).orderBy(asc(sections.position)),
	}))

describe('normaliseUrl', () => {
	it('adds https, drops the fragment and tracking parameters, and keeps the rest', () => {
		expect(normaliseUrl('  Example.COM/a?b=1&utm_source=news&fbclid=x#top ')).toBe('https://example.com/a?b=1')
		expect(normaliseUrl('http://example.com:80/')).toBe('http://example.com/')
	})
	it('refuses text that is not a web address', () => {
		for (const text of ['hello world', 'notes', 'javascript:alert(1)', 'ftp://example.com/file']) expect(normaliseUrl(text), text).toBeNull()
	})
})

describe('importReading', () => {
	it('stores the article as sections and sets the reading ready', async () => {
		const userId = await member()
		const url = site.serve('/wiki/spaced', fixture('wikipedia-spaced-repetition.html'))
		const { reading, sections: stored } = await load(userId, await add(userId, url))
		// Its canonical address is on wikipedia.org, another site than the one that served it, so it is ignored.
		expect(reading).toMatchObject({ status: 'ready', error: null, title: 'Spaced repetition', sourceUrl: url })
		expect(stored.map((s) => s.title)).toContain('History')
		expect(reading.wordCount).toBe(stored.reduce((n, s) => n + s.wordCount, 0))
	})

	it('runs again without storing the sections twice', async () => {
		const userId = await member()
		const id = await add(userId, site.serve('/again', fixture('mdn-execution-model.html')))
		const before = (await load(userId, id)).sections.length
		await importReading({ readingId: id, userId })
		expect((await load(userId, id)).sections).toHaveLength(before)
	})

	it('merges a second link to a page the member already has into the first reading', async () => {
		const userId = await member()
		const page = article('<link rel="canonical" href="/posts/rings">')
		const first = await add(userId, site.serve('/posts/rings', page))
		const second = await add(userId, site.serve('/p/123', page))
		const merged = await load(userId, second)
		expect(merged.reading).toMatchObject({ status: 'ready', mergedInto: first })
		expect(merged.sections).toHaveLength(0)
		// Another member with the same page gets their own copy.
		const other = await member()
		expect((await load(other, await add(other, `${TEST_SITE}/p/123`))).reading.mergedInto).toBeNull()
	})

	it('marks the reading failed with a message the member can act on', async () => {
		const userId = await member()
		const failure = async (url: string) => (await load(userId, await add(userId, url))).reading
		expect(await failure(`${TEST_SITE}/status/404`)).toMatchObject({ status: 'failed', error: expect.stringContaining('(404)') })
		expect(await failure(`${TEST_SITE}/redirect?to=${encodeURIComponent('http://127.0.0.1:9/')}`)).toMatchObject({
			error: 'Life Log Club can only open public web pages.',
		})
		site.serve('/login', { body: '<form><input type="password"></form>', headers: { 'content-type': 'text/html' } })
		expect(await failure(`${TEST_SITE}/redirect?to=/login`)).toMatchObject({ error: expect.stringContaining('signed in') })
		site.serve('/paper.pdf', { body: '%PDF-1.7 …', headers: { 'content-type': 'application/pdf' } })
		expect(await failure(`${TEST_SITE}/paper.pdf`)).toMatchObject({ error: expect.stringContaining('This link is a PDF') })
	})

	it('leaves a reading importing and throws, so the job retries, when the site did not answer and tries remain', async () => {
		const userId = await member()
		const id = randomUUID()
		await asUser(userId, (tx) => tx.insert(readings).values({ id, userId, title: 'x', source: 'url', requestedUrl: `${TEST_SITE}/status/503` }))
		await expect(importReading({ readingId: id, userId }, false)).rejects.toThrow("didn't answer")
		expect((await load(userId, id)).reading.status).toBe('importing')
		await importReading({ readingId: id, userId }, true)
		expect((await load(userId, id)).reading).toMatchObject({ status: 'failed', error: "The site didn't answer. Try again in a minute." })
	})

	it("keeps a member's readings and sections from every other member", async () => {
		const owner = await member()
		const id = await add(owner, site.serve('/private', fixture('mdn-execution-model.html')))
		const stranger = await member()
		const seen = await asUser(stranger, async (tx) => ({
			readings: await tx.select().from(readings).where(eq(readings.id, id)),
			sections: await tx.select().from(sections).where(eq(sections.readingId, id)),
		}))
		expect(seen).toEqual({ readings: [], sections: [] })
		// The job runs as the member who owns the reading id it is given, so a wrong pairing finds nothing.
		await importReading({ readingId: id, userId: stranger })
		expect((await load(owner, id)).reading.status).toBe('ready')
	})
})
