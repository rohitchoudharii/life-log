import { randomUUID } from 'node:crypto'
import { defaultScheduler } from '@life-log-club/domain'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { encrypt } from '../crypto'
import { asUser, ownerDb, ownerPool, pool } from '../db/client'
import { prepareDatabase } from '../db/prepare'
import { aiCalls, aiKeys, cards, preferences, questions, readings, reviewLog, sections, users } from '../db/schema'
import { testSite } from '../import/test-site'
import { keyContext } from './ai'
import { cardsToTopUp, topUpQuestions } from './top-up'

const site = testSite()
beforeAll(async () => {
	await prepareDatabase()
	await site.start()
})
afterAll(() => Promise.all([site.stop(), pool.end(), ownerPool.end()]))

const DAY = 86_400_000
const now = new Date()
const at = (days: number) => new Date(now.getTime() + days * DAY)
const TEXT = 'Recall after a gap is harder than recall right away, and the effort is what makes a memory last.'

/** A member with a ready reading of one section, and an AI key when `withKey`. */
async function member(withKey = true) {
	const [user] = await ownerDb.insert(users).values({ email: `top-up-${randomUUID()}@example.com`, name: 'T' }).returning()
	const userId = user!.id
	const readingId = randomUUID()
	const section = await asUser(userId, async (tx) => {
		if (withKey) await tx.insert(aiKeys).values({ userId, provider: 'anthropic', model: 'claude-haiku-5-5', keyCt: encrypt('sk-ant-test', keyContext(userId)), last4: 'test' })
		await tx.insert(readings).values({ id: readingId, userId, title: 'Memory', source: 'url', status: 'ready' })
		const [row] = await tx
			.insert(sections)
			.values({ userId, readingId, position: 0, level: 1, title: 'Spacing', blocks: [{ type: 'paragraph', text: TEXT }], wordCount: 20 })
			.returning()
		return row!
	})
	/** A key idea card of the section, with one question asked `askedDaysAgo` days ago, or unasked when null. */
	const card = (name: string, dueInDays: number, opts: { started?: boolean; askedDaysAgo?: number | null; writtenDaysAgo?: number; level?: number } = {}) =>
		asUser(userId, async (tx) => {
			const id = randomUUID()
			await tx.insert(cards).values({
				id,
				userId,
				kind: 'idea',
				origin: 'ai',
				readingId,
				sectionId: section.id,
				prompt: `Cue ${name}?`,
				answer: `Idea ${name}: the effort of recall is what makes a memory last.`,
				quote: TEXT,
				level: opts.level ?? 1,
				state: defaultScheduler.initial(),
				startedAt: opts.started === false ? null : at(-20),
				dueAt: at(dueInDays),
			})
			const [q] = await tx
				.insert(questions)
				.values({
					userId,
					cardId: id,
					readingId,
					sectionId: section.id,
					type: 'short_answer',
					level: 'explain',
					content: { prompt: `Why does idea ${name} hold?`, reference: 'Effort builds memory.', mustHave: [], misconceptions: [] },
					createdAt: at(-(opts.writtenDaysAgo ?? 30)),
				})
				.returning()
			const asked = opts.askedDaysAgo === undefined ? 3 : opts.askedDaysAgo
			if (asked !== null)
				await tx.insert(reviewLog).values({
					userId,
					cardId: id,
					answerId: randomUUID(),
					questionId: q!.id,
					mode: 'review',
					rating: 'good',
					correct: true,
					reviewedAt: at(-asked),
					nextDueAt: at(dueInDays),
				})
			return id
		})
	return { userId, card }
}

/** The AI's reply to the top-up: one question for request 1. */
const reply = () =>
	site.serve('/v1/messages', {
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			content: [
				{
					type: 'text',
					text: JSON.stringify({
						questions: [
							{
								id: 1,
								type: 'short_answer',
								level: 'apply',
								content: {
									prompt: 'How would a coach plan practice if forgetting made recall stronger?',
									reference: 'They would space sessions so that each recall takes effort.',
									mustHave: ['space the sessions', 'recall should take effort'],
									misconceptions: [],
								},
							},
						],
					}),
				},
			],
			usage: { input_tokens: 500, output_tokens: 120 },
		}),
	})

it('picks started cards due within 2 days whose questions were all asked and none written in the last 7 days', async () => {
	const { userId, card } = await member()
	const wanted = await card('due-soon', 1.5)
	const overdue = await card('overdue', -1)
	await card('due-later', 5)
	await card('has-unasked', 1, { askedDaysAgo: null })
	await card('written-lately', 1, { writtenDaysAgo: 3 })
	await card('not-started', 1, { started: false, askedDaysAgo: null })
	const picked = await cardsToTopUp(userId, now, 10)
	expect(picked.map((p) => p.card.id)).toEqual([overdue, wanted])
})

it('writes one fresh question at the card’s level for a card due in 2 days with no unasked question', async () => {
	const { userId, card } = await member()
	const id = await card('one', 2, { level: 2 })
	reply()
	expect(await topUpQuestions({ userId }, now)).toBe(1)
	const rows = await asUser(userId, (tx) => tx.select().from(questions).where(eq(questions.cardId, id)))
	expect(rows).toHaveLength(2)
	const fresh = rows.find((q) => q.content.prompt === 'How would a coach plan practice if forgetting made recall stronger?')
	expect(fresh).toMatchObject({ level: 'apply', retiredAt: null })
	// Topped up within 7 days: not again.
	expect(await cardsToTopUp(userId, now, 10)).toEqual([])
	expect(await topUpQuestions({ userId }, now)).toBe(0)
})

it('is skipped without a key, on Quick, and past the monthly budget, with no AI call', async () => {
	const without = await member(false)
	await without.card('a', 1)
	expect(await topUpQuestions({ userId: without.userId }, now)).toBe(0)
	const quick = await member()
	await quick.card('b', 1)
	await asUser(quick.userId, (tx) => tx.insert(preferences).values({ userId: quick.userId, questionAmount: 'quick' }))
	expect(await topUpQuestions({ userId: quick.userId }, now)).toBe(0)
	const spent = await member()
	await spent.card('c', 1)
	await asUser(spent.userId, (tx) => tx.insert(preferences).values({ userId: spent.userId, aiMonthlyBudgetUsd: 0 }))
	expect(await topUpQuestions({ userId: spent.userId }, now)).toBe(0)
	for (const userId of [without.userId, quick.userId, spent.userId]) expect(await asUser(userId, (tx) => tx.select().from(aiCalls))).toEqual([])
})
