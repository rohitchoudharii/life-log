import { randomUUID } from 'node:crypto'
import { asc, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { encrypt } from '../crypto'
import { asUser, ownerDb, ownerPool, pool } from '../db/client'
import { prepareDatabase } from '../db/prepare'
import { aiCalls, aiKeys, readings, sections, users } from '../db/schema'
import { keyContext } from '../learning/ai'
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

describe('AI headings for an article with no headings (issue #1, rule 3)', () => {
	// 16 paragraphs of 81 words: 1,296 words, past the 1,000 that ask for headings. 12 are 972.
	const para = (i: number) => `<p>${`Paragraph ${i} explains one more step of how a database keeps old row versions until vacuum runs`.split(' ').concat(Array(64).fill('again')).join(' ')}.</p>`
	const essay = (paragraphs: number) => ({
		body: `<html><head><title>Dead rows</title></head><body><article><h1>Dead rows</h1>${Array.from({ length: paragraphs }, (_, i) => para(i)).join('')}</article></body></html>`,
		headers: { 'content-type': 'text/html; charset=utf-8' },
	})
	const aiReply = (headings: unknown, status = 200) =>
		site.serve('/v1/messages', {
			status,
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(status === 200 ? { content: [{ type: 'text', text: JSON.stringify({ headings }) }], usage: { input_tokens: 1700, output_tokens: 42 } } : { error: { message: 'overloaded' } }),
		})
	async function memberWithKey() {
		const userId = await member()
		await asUser(userId, (tx) =>
			tx.insert(aiKeys).values({ userId, provider: 'anthropic', model: 'claude-haiku-5-5', keyCt: encrypt('sk-ant-test', keyContext(userId)), last4: 'test' }),
		)
		return userId
	}
	const calls = (userId: string) => asUser(userId, (tx) => tx.select().from(aiCalls))
	const good = [
		{ before: 1, title: 'Why rows linger', level: 2 },
		{ before: 9, title: 'What vacuum does', level: 2 },
	]

	it('splits at the headings the AI placed, marks them as AI-written, and keeps every word', async () => {
		const userId = await memberWithKey()
		aiReply(good)
		const url = site.serve(`/essay/${randomUUID()}`, essay(16))
		const { reading, sections: stored } = await load(userId, await add(userId, url))
		expect(stored.map((s) => [s.title, s.level, s.aiTitle])).toEqual([
			['Why rows linger', 1, true],
			['What vacuum does', 1, true],
		])
		expect(stored.map((s) => s.blocks.length)).toEqual([8, 8])
		expect(stored.flatMap((s) => s.blocks)).toEqual(Array.from({ length: 16 }, (_, i) => ({ type: 'paragraph', text: expect.stringContaining(`Paragraph ${i} explains`) })))
		expect(reading.wordCount).toBe(1296)
		expect(await calls(userId)).toEqual([expect.objectContaining({ purpose: 'headings', model: 'claude-haiku-5-5', ok: true, inputTokens: 1700, outputTokens: 42 })])
	})

	it('keeps the article as one section when the reply fails its checks, the provider fails, or there is no key', async () => {
		const oneSection = async (userId: string) => {
			const { sections: stored } = await load(userId, await add(userId, site.serve(`/essay/${randomUUID()}`, essay(16))))
			return stored.map((s) => [s.title, s.aiTitle, s.blocks.length])
		}
		const invalid = await memberWithKey()
		aiReply([...good, { before: 99, title: 'Past the end', level: 2 }])
		expect(await oneSection(invalid)).toEqual([['Dead rows', false, 16]])

		const failed = await memberWithKey()
		aiReply(null, 529)
		expect(await oneSection(failed)).toEqual([['Dead rows', false, 16]])
		expect(await calls(failed)).toEqual([expect.objectContaining({ ok: false, error: 'overloaded' })])

		const noKey = await member()
		expect(await oneSection(noKey)).toEqual([['Dead rows', false, 16]])
		expect(await calls(noKey)).toEqual([])
	})

	it('does not ask the AI about an article under 1,000 words or one with its own headings', async () => {
		const userId = await memberWithKey()
		aiReply(good)
		site.takeHits()
		await add(userId, site.serve(`/essay/${randomUUID()}`, essay(12)))
		await add(userId, site.serve('/with-headings', fixture('mdn-execution-model.html')))
		expect(site.takeHits().get('/v1/messages')).toBeUndefined()
		expect(await calls(userId)).toEqual([])
	})
})
