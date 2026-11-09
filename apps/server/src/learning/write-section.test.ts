import { randomUUID } from 'node:crypto'
import { asc, eq } from 'drizzle-orm'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { encrypt } from '../crypto'
import { asUser, ownerDb, ownerPool, pool } from '../db/client'
import { prepareDatabase } from '../db/prepare'
import { aiCalls, aiKeys, cards, questions, readings, sections, users } from '../db/schema'
import { testSite } from '../import/test-site'
import { keyContext } from './ai'
import { CHAPTER_BATCH_WORDS, chapterBatches, writeKeyIdeas } from './write-section'

const site = testSite()
beforeAll(async () => {
	await prepareDatabase()
	await site.start()
})
afterAll(() => Promise.all([site.stop(), pool.end(), ownerPool.end()]))

const SHORT = 'Most of what we read is gone within a week of reading it.'
const LONG = Array.from({ length: 12 }, (_, i) => `Sentence ${i} says that recall after a gap is harder than recall right away.`).join(' ')

async function member(withKey: boolean) {
	const [user] = await ownerDb.insert(users).values({ email: `writer-${randomUUID()}@example.com`, name: 'W' }).returning()
	const userId = user!.id
	if (withKey)
		await asUser(userId, (tx) =>
			tx.insert(aiKeys).values({ userId, provider: 'anthropic', model: 'claude-haiku-5-5', keyCt: encrypt('sk-ant-test', keyContext(userId)), last4: 'test' }),
		)
	return userId
}

/** A ready reading with a short first section and a longer second one. */
async function reading(userId: string) {
	const readingId = randomUUID()
	return asUser(userId, async (tx) => {
		await tx.insert(readings).values({ id: readingId, userId, title: 'Memory', source: 'url', status: 'ready' })
		const words = (t: string) => t.split(' ').length
		return tx
			.insert(sections)
			.values(
				[SHORT, LONG].map((text, position) => ({
					userId,
					readingId,
					position,
					level: 1,
					title: `Part ${position + 1}`,
					blocks: [{ type: 'paragraph' as const, text }],
					wordCount: words(text),
				})),
			)
			.returning()
	})
}

const idea = (section: number, quote: string, n: number) => ({
	section,
	rank: n,
	idea: `Idea ${n} about memory.`,
	cue: `Which point number ${n} did this part make?`,
	quote,
	questions: [
		{
			type: 'short_answer',
			level: 'explain',
			content: {
				prompt: `Why would a learner who waits ${n} days keep more?`,
				reference: 'Harder recall builds a stronger memory.',
				mustHave: ['effortful retrieval strengthens memory', 'easy rereading gives little practice'],
			},
		},
	],
})
/** Every AI call gets this reply: two ideas, one quoting each section, both named as section 1. */
const reply = () =>
	site.serve('/v1/messages', {
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			content: [{ type: 'text', text: JSON.stringify({ ideas: [idea(1, SHORT, 1), idea(1, 'Sentence 3 says that recall after a gap is harder', 2)] }) }],
			usage: { input_tokens: 900, output_tokens: 300 },
		}),
	})

const stored = (userId: string) =>
	asUser(userId, async (tx) => ({
		sections: await tx.select({ id: sections.id, writeStatus: sections.writeStatus }).from(sections).orderBy(asc(sections.position)),
		cards: await tx.select().from(cards).orderBy(asc(cards.position)),
		questions: await tx.select().from(questions),
	}))

it('writes a short section with the next one, and each section keeps the ideas it quotes', async () => {
	const userId = await member(true)
	const [short, long] = await reading(userId)
	reply()
	expect(await writeKeyIdeas({ userId, sectionId: short!.id })).toBe('ready')
	const after = await stored(userId)
	expect(after.sections.map((s) => s.writeStatus)).toEqual(['ready', 'ready'])
	// Each card is first in its own section, so both have position 0 and come back in either order.
	expect(after.cards).toHaveLength(2)
	expect(after.cards.map((c) => [c.sectionId, c.answer, c.origin, c.startedAt])).toEqual(
		expect.arrayContaining([
			[short!.id, 'Idea 1 about memory.', 'ai', null],
			[long!.id, 'Idea 2 about memory.', 'ai', null],
		]),
	)
	expect(after.questions.map((q) => q.cardId).sort()).toEqual(after.cards.map((c) => c.id).sort())
})

it('writes the ideas once when two jobs for the same section run at the same time', async () => {
	const userId = await member(true)
	const [, long] = await reading(userId)
	reply()
	await Promise.all([writeKeyIdeas({ userId, sectionId: long!.id }), writeKeyIdeas({ userId, sectionId: long!.id })])
	const after = await stored(userId)
	expect(after.cards.filter((c) => c.sectionId === long!.id)).toHaveLength(1)
	expect(after.questions).toHaveLength(1)
	// A section already written is not asked about again.
	const calls = (await asUser(userId, (tx) => tx.select().from(aiCalls))).length
	expect(await writeKeyIdeas({ userId, sectionId: long!.id })).toBe('ready')
	expect(await asUser(userId, (tx) => tx.select().from(aiCalls))).toHaveLength(calls)
})

it('waits for a key without one, and makes no AI call', async () => {
	const userId = await member(false)
	const [, long] = await reading(userId)
	expect(await writeKeyIdeas({ userId, sectionId: long!.id })).toBe('needs_key')
	const [row] = await asUser(userId, (tx) => tx.select({ writeStatus: sections.writeStatus }).from(sections).where(eq(sections.id, long!.id)))
	expect(row!.writeStatus).toBe('needs_key')
	expect(await asUser(userId, (tx) => tx.select().from(aiCalls))).toEqual([])
})

it('splits a chapter into batches of up to 4,000 words, in order, with a longer section on its own', () => {
	const words = (...counts: number[]) => counts.map((wordCount, i) => ({ id: i, wordCount }))
	const ids = (list: { id: number }[][]) => list.map((b) => b.map((s) => s.id))
	expect(CHAPTER_BATCH_WORDS).toBe(4000)
	// 1,500 + 2,500 fills a batch exactly; the next section starts a new one.
	expect(ids(chapterBatches(words(1500, 2500, 100)))).toEqual([[0, 1], [2]])
	expect(ids(chapterBatches(words(1500, 2501, 100)))).toEqual([[0], [1, 2]])
	expect(ids(chapterBatches(words(5000, 200, 300)))).toEqual([[0], [1, 2]])
	expect(chapterBatches([])).toEqual([])
})
