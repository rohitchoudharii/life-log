import { randomUUID } from 'node:crypto'
import { defaultScheduler } from '@life-log-club/domain'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { asUser, ownerDb, ownerPool, pool } from '../db/client'
import { prepareDatabase } from '../db/prepare'
import { cards, questions, readings, reviewLog, sections, users } from '../db/schema'

beforeAll(prepareDatabase)
afterAll(() => Promise.all([pool.end(), ownerPool.end()]))

async function member() {
	const [user] = await ownerDb
		.insert(users)
		.values({ email: `rls-${randomUUID()}@example.com`, name: 'M' })
		.returning()
	return user!.id
}

/** A ready reading with one section, one key idea card, one question on it and one answer. */
async function readingWithIdea(userId: string) {
	const readingId = randomUUID()
	const cardId = randomUUID()
	return asUser(userId, async (tx) => {
		await tx.insert(readings).values({ id: readingId, userId, title: 'Memory', source: 'url', status: 'ready' })
		const [section] = await tx
			.insert(sections)
			.values({ userId, readingId, position: 0, level: 1, title: 'Spacing', blocks: [], wordCount: 300 })
			.returning()
		await tx.insert(cards).values({
			id: cardId,
			userId,
			kind: 'idea',
			origin: 'ai',
			readingId,
			sectionId: section!.id,
			position: 0,
			prompt: 'Why do gaps between reviews help?',
			answer: 'Recall after a gap is harder, and the effort makes the memory last.',
			quote: 'The effort of recall after a gap is what makes it last.',
			state: defaultScheduler.initial(),
		})
		const [question] = await tx
			.insert(questions)
			.values({
				userId,
				cardId,
				readingId,
				sectionId: section!.id,
				type: 'short_answer',
				level: 'explain',
				content: { prompt: 'Why does a gap help?', reference: 'Harder recall lasts longer.' },
			})
			.returning()
		await tx.insert(reviewLog).values({
			userId,
			cardId,
			answerId: randomUUID(),
			questionId: question!.id,
			ask: 'question',
			mode: 'recall',
			rating: 'good',
			correct: true,
			gradedBy: 'ai',
			nextDueAt: new Date(),
		})
		return { readingId, cardId, questionId: question!.id }
	})
}

it("keeps a member's key ideas, questions and answers from every other member", async () => {
	const [a, b] = [await member(), await member()]
	const mine = await readingWithIdea(a)

	const seen = (userId: string) =>
		asUser(userId, async (tx) => ({
			cards: await tx.select().from(cards),
			questions: await tx.select().from(questions),
			log: await tx.select().from(reviewLog),
		}))
	const own = await seen(a)
	expect(own.cards.map((c) => c.id)).toEqual([mine.cardId])
	expect(own.cards[0]).toMatchObject({ origin: 'ai', level: 0, startedAt: null, deletedAt: null })
	expect(own.questions.map((q) => q.id)).toEqual([mine.questionId])
	expect(own.log).toHaveLength(1)
	expect(await seen(b)).toEqual({ cards: [], questions: [], log: [] })

	// Row-level security also refuses a row written for another member.
	await expect(
		asUser(b, (tx) =>
			tx.insert(questions).values({ userId: a, cardId: mine.cardId, type: 'short_answer', level: 'explain', content: {} }),
		),
	).rejects.toThrow()
})
