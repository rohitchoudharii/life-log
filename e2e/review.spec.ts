import { randomUUID } from 'node:crypto'
import { ORPCError } from '@orpc/client'
import { expect, test } from '@playwright/test'
import { newMember } from './api'
import { sql } from './db'

test.beforeEach(({}, info) => test.skip(info.project.name !== 'desktop', 'API only'))

const DAY = 86_400_000
const code = (promise: Promise<unknown>) =>
	promise.then(
		() => 'ok',
		(e: unknown) => (e instanceof ORPCError ? e.code : String(e)),
	)
/** Days from now to `date`, rounded to a tenth. */
const daysUntil = (date: Date) => Math.round(((date.getTime() - Date.now()) / DAY) * 10) / 10
/** Moves the card's due time into the past, as if the days had passed. */
/** A self-rated answer from the queue, with a fresh answer id. */
const rate = (cardId: string, rating: 'again' | 'hard' | 'good' | 'easy', answerId = randomUUID()) =>
	({ answerId, cardId, mode: 'review', ask: 'self', rating }) as const
const makeDue = (id: string) => sql(`update cards set due_at = now() - interval '1 second' where id = $1`, [id])

test('a new card is due at once, then comes back after 1, 2 and 3 days, then a longer gap', async () => {
	const { client } = await newMember()
	const card = await client.review.add({
		id: randomUUID(),
		kind: 'idea',
		prompt: 'What does deliberate practice need besides effort?',
		answer: 'Immediate feedback on what to fix.',
	})
	expect((await client.review.due({})).cards.map((c) => c.id)).toEqual([card.id])

	const gaps: number[] = []
	for (let i = 0; i < 4; i++) {
		const { dueAt } = await client.review.answer(rate(card.id, 'good'))
		gaps.push(daysUntil(dueAt))
		expect((await client.review.due({})).total).toBe(0)
		await makeDue(card.id)
	}
	expect(gaps).toEqual([1, 2, 3, 8])

	const log = await sql<{ rating: string; ask: string; mode: string; scheduler: string }>(
		'select rating, ask, mode, scheduler from review_log where card_id = $1',
		[card.id],
	)
	expect(log.map((r) => r.rating)).toEqual(['good', 'good', 'good', 'good'])
	// A self-rated answer from the queue, decided by today's scheduler.
	expect(log[0]).toMatchObject({ ask: 'self', mode: 'review', scheduler: 'steps-ease-v1' })
})

test('a forgotten card comes back in 10 minutes, and an answer to a card not yet due is refused', async () => {
	const { client } = await newMember()
	const card = await client.review.add({ id: randomUUID(), kind: 'lesson', prompt: 'Say the number first', answer: 'In salary talks, anchor high.' })
	const first = rate(card.id, 'again')
	const { dueAt } = await client.review.answer(first)
	expect(Math.round((dueAt.getTime() - Date.now()) / 60_000)).toBe(10)
	// A double tap or a retry of the same answer counts once and gives the same result.
	expect((await client.review.answer(first)).dueAt).toEqual(dueAt)
	// Another answer to a card that is no longer due is refused.
	expect(await code(client.review.answer(rate(card.id, 'again')))).toBe('CONFLICT')
	expect(await sql('select 1 from review_log where card_id = $1', [card.id])).toHaveLength(1)
})

test('lessons and ideas share one queue, oldest due first, and a lesson can point at its entry', async () => {
	const { client } = await newMember()
	const entry = await client.entries.create({ id: randomUUID(), type: 'lesson', details: {}, text: 'Rest days count' })
	const lesson = await client.review.add({ id: randomUUID(), kind: 'lesson', prompt: 'Rest days?', answer: 'They count.', entryId: entry.id })
	const idea = await client.review.add({ id: randomUUID(), kind: 'idea', prompt: 'Mental representations?', answer: 'Chunks experts use.' })
	await sql(`update cards set due_at = now() - interval '2 days' where id = $1`, [idea.id])

	const due = await client.review.due({})
	expect(due.total).toBe(2)
	expect(due.cards.map((c) => [c.kind, c.entryId])).toEqual([
		['idea', null],
		['lesson', entry.id],
	])
	expect(lesson.entryId).toBe(entry.id)
})

test("a member can't review another member's cards or link a card to their entries", async () => {
	const a = await newMember('A')
	const b = await newMember('B')
	const entry = await a.client.entries.create({ id: randomUUID(), type: 'lesson', details: {}, text: 'A only' })
	const card = await a.client.review.add({ id: randomUUID(), kind: 'idea', prompt: 'A prompt', answer: 'A answer' })

	expect(await b.client.review.due({})).toEqual({ cards: [], total: 0 })
	expect(await code(b.client.review.answer(rate(card.id, 'easy')))).toBe('NOT_FOUND')
	expect(
		await code(b.client.review.add({ id: randomUUID(), kind: 'lesson', prompt: 'x', answer: 'y', entryId: entry.id })),
	).toBe('NOT_FOUND')
	expect(await code(b.client.review.add({ id: card.id, kind: 'idea', prompt: 'x', answer: 'y' }))).toBe('CONFLICT')
	expect((await a.client.review.due({})).cards[0]?.prompt).toBe('A prompt')
})
