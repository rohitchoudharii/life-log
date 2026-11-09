import { randomUUID } from 'node:crypto'
import { ORPCError } from '@orpc/client'
import { expect, test } from '@playwright/test'
import { newMember } from './api'
import { sql } from './db'
import { GOOD_ANTHROPIC_KEY } from './env'

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
	// Other clients still add a lesson's card themselves, so this entry makes none.
	const entry = await client.entries.create({ id: randomUUID(), type: 'lesson', details: {}, text: 'Rest days count', remember: false })
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

test('a lesson entry makes its card: an edit changes the answer and keeps the schedule, removing hides it, restoring brings it back', async () => {
	const { client } = await newMember()
	const cardOf = (entryId: string) =>
		sql<{ id: string; prompt: string; answer: string; due_at: Date; deleted_at: Date | null }>(
			'select id, prompt, answer, due_at, deleted_at from cards where entry_id = $1',
			[entryId],
		)
	expect((await client.review.due({})).total).toBe(0)
	const occurredAt = new Date(Date.UTC(2026, 10, 3, 9))
	const entry = await client.entries.create({ id: randomUUID(), type: 'lesson', details: {}, text: 'Rest days count as training.', occurredAt })
	expect((await client.review.due({})).total).toBe(1)
	// A retried create makes no second card.
	await client.entries.create({ id: entry.id, type: 'lesson', details: {}, text: 'Rest days count as training.' })
	const [card] = await cardOf(entry.id)
	expect(await cardOf(entry.id)).toHaveLength(1)
	expect(card!.prompt).toBe('Your lesson from 3 Nov: what was it?')
	expect(card!.answer).toBe('Rest days count as training.')

	await client.review.answer(rate(card!.id, 'good'))
	const [reviewed] = await cardOf(entry.id)
	await client.entries.update({ id: entry.id, text: 'Rest days are part of training.', details: { cue: 'Skipping the gym' } })
	const [edited] = await cardOf(entry.id)
	expect(edited).toMatchObject({ answer: 'Rest days are part of training.', prompt: "Skipping the gym: what's the lesson?", due_at: reviewed!.due_at })
	expect(await code(client.entries.update({ id: entry.id, text: ' ' }))).toBe('BAD_REQUEST')
	expect(await code(client.entries.create({ id: randomUUID(), type: 'lesson', details: {}, text: '' }))).toBe('BAD_REQUEST')

	await makeDue(card!.id)
	expect((await client.review.due({})).total).toBe(1)
	await client.entries.remove({ id: entry.id })
	expect((await client.review.due({})).total).toBe(0)
	expect(await code(client.review.answer(rate(card!.id, 'good')))).not.toBe('ok')
	await client.entries.restore({ id: entry.id })
	expect((await client.review.due({})).total).toBe(1)
	expect((await cardOf(entry.id))[0]!.deleted_at).toBeNull()

	const forgotten = await client.entries.create({ id: randomUUID(), type: 'lesson', details: {}, text: 'Just a note.', remember: false })
	expect(await cardOf(forgotten.id)).toHaveLength(0)
})

test('with a key, a lesson logged without a cue gets one written by AI; a cue the member gave stays', async () => {
	const { client } = await newMember()
	await client.ai.saveKey({ provider: 'anthropic', apiKey: GOOD_ANTHROPIC_KEY })
	const plain = await client.entries.create({ id: randomUUID(), type: 'lesson', details: {}, text: 'Say a number first and anchor high.' })
	const given = await client.entries.create({ id: randomUUID(), type: 'lesson', details: { cue: 'Salary talks' }, text: 'Anchor high.' })
	const prompt = (entryId: string) => sql<{ prompt: string }>('select prompt from cards where entry_id = $1', [entryId]).then((r) => r[0]!.prompt)
	await expect.poll(() => prompt(plain.id), { timeout: 10_000 }).toBe('Where did this lesson come up for you?')
	expect(await prompt(given.id)).toBe("Salary talks: what's the lesson?")
	const [call] = await sql<{ n: number }>(
		`select count(*)::int as n from ai_calls where purpose = 'lesson-cue' and user_id = (select user_id from cards where entry_id = $1)`,
		[plain.id],
	)
	expect(call!.n).toBe(1)
})

test("a member can't review another member's cards or link a card to their entries", async () => {
	const a = await newMember('A')
	const b = await newMember('B')
	const entry = await a.client.entries.create({ id: randomUUID(), type: 'lesson', details: {}, text: 'A only', remember: false })
	const card = await a.client.review.add({ id: randomUUID(), kind: 'idea', prompt: 'A prompt', answer: 'A answer' })

	expect(await b.client.review.due({})).toEqual({ cards: [], total: 0, minutes: 0 })
	expect(await code(b.client.review.answer(rate(card.id, 'easy')))).toBe('NOT_FOUND')
	expect(
		await code(b.client.review.add({ id: randomUUID(), kind: 'lesson', prompt: 'x', answer: 'y', entryId: entry.id })),
	).toBe('NOT_FOUND')
	expect(await code(b.client.review.add({ id: card.id, kind: 'idea', prompt: 'x', answer: 'y' }))).toBe('CONFLICT')
	expect((await a.client.review.due({})).cards[0]?.prompt).toBe('A prompt')
})

test("a member can't reach another member's recall check, its marks or a card's checklist", async () => {
	const a = await newMember('A')
	const b = await newMember('B')
	expect(await a.client.readings.addSample()).toEqual({ added: true })
	expect(await a.client.readings.addSample()).toEqual({ added: false })
	const [sample] = await a.client.readings.list()
	const { contents } = await a.client.readings.get({ id: sample!.id })
	const attempt = await a.client.recall.start({ id: randomUUID(), readingId: sample!.id, sectionIds: [contents[0]!.id] })
	await a.client.recall.submit({ id: attempt.id, text: 'Rereading feels like learning.' })
	await expect.poll(async () => (await a.client.recall.get({ id: attempt.id })).status, { timeout: 10_000 }).toBe('self')
	const { toMark } = await a.client.recall.get({ id: attempt.id })
	expect(toMark).toHaveLength(3)
	const cardId = toMark![0]!.cardId

	expect(await code(b.client.recall.get({ id: attempt.id }))).toBe('NOT_FOUND')
	expect(await code(b.client.recall.selfMark({ id: attempt.id, marks: [{ cardId, status: 'covered' }] }))).toBe('NOT_FOUND')
	expect(await code(b.client.review.checklist({ cardId, questionId: null }))).toBe('NOT_FOUND')
	expect(await b.client.readings.list()).toEqual([])
	// B's marks changed nothing: A still marks their own dump.
	expect((await a.client.recall.get({ id: attempt.id })).status).toBe('self')
	expect((await a.client.review.checklist({ cardId, questionId: null })).points).toEqual([toMark![0]!.idea])
	expect((await a.client.recall.selfMark({ id: attempt.id, marks: [{ cardId, status: 'covered' }] })).status).toBe('graded')
})

type Member = Awaited<ReturnType<typeof newMember>>
const IDEA = { prompt: 'Why does spacing beat cramming?', answer: 'Spaced practice leaves time to forget, so each recall works harder.' }
const MUST_HAVE = ['forgetting between sessions', 'harder retrieval strengthens memory']
const RIGHT = 'Forgetting between sessions makes the harder retrieval strengthen memory.'
/** A due idea at `level` with one stored written question per level in `levels`, as write-section makes them. */
async function ideaWithQuestions(member: Member, levels: string[], level = 1) {
	const card = await member.client.review.add({ id: randomUUID(), kind: 'idea', ...IDEA })
	await sql('update cards set level = $2 where id = $1', [card.id, level])
	const questionIds: string[] = []
	for (const at of levels) {
		const id = randomUUID()
		const content = { prompt: `At ${at}: why does spacing help?`, reference: 'Forgetting first makes retrieval harder, and harder retrieval strengthens memory.', mustHave: MUST_HAVE, misconceptions: [] }
		await sql("insert into questions (id, user_id, card_id, type, level, content) values ($1, $2, $3, 'short_answer', $4, $5)", [id, member.user.id, card.id, at, content])
		questionIds.push(id)
	}
	return { card, questionIds }
}
const withKey = async (name?: string) => {
	const member = await newMember(name)
	await member.client.ai.saveKey({ provider: 'anthropic', apiKey: GOOD_ANTHROPIC_KEY })
	return member
}
const written = (cardId: string, questionId: string, answer: string | null, confidence: 'guessing' | 'think_so' | 'sure' | null = 'think_so') =>
	({ answerId: randomUUID(), cardId, mode: 'review', ask: 'question', questionId, response: answer === null ? { skipped: true } : { answer }, confidence }) as const
const cardRow = (id: string) => sql<{ level: number; due_at: Date }>('select level, due_at from cards where id = $1', [id]).then((r) => r[0]!)

test('Review asks a question not asked yet nearest the card’s level, then the cue; without a key every card is self-rated', async () => {
	const a = await withKey('A')
	const { card, questionIds } = await ideaWithQuestions(a, ['explain', 'apply', 'analyze'], 2)
	const [explain, apply, analyze] = questionIds
	const askOf = async () => (await a.client.review.next({})).items[0]!.ask
	expect(await a.client.review.next({})).toMatchObject({ total: 1, minutes: 1, items: [{ cardId: card.id, kind: 'idea', source: null, cue: IDEA.prompt }] })
	// Level 2 is apply.
	expect(await askOf()).toEqual({ kind: 'question', questionId: apply, type: 'short_answer', prompt: 'At apply: why does spacing help?', code: null })
	expect(await a.client.review.answer(written(card.id, apply!, RIGHT))).toMatchObject({ correct: true, rating: 'good' })
	expect(await cardRow(card.id)).toMatchObject({ level: 3 })
	await makeDue(card.id)
	// Level 3 is analyze; after a miss the card drops to 2, and the nearest unasked one below it comes next.
	expect(await askOf()).toMatchObject({ kind: 'question', questionId: analyze })
	expect(await a.client.review.answer(written(card.id, analyze!, null, null))).toMatchObject({ correct: false, rating: 'again' })
	expect(await cardRow(card.id)).toMatchObject({ level: 2 })
	await makeDue(card.id)
	expect(await askOf()).toMatchObject({ kind: 'question', questionId: explain })
	await a.client.review.answer(written(card.id, explain!, RIGHT))
	await makeDue(card.id)
	// Every question has been asked: the cue, judged with the key.
	expect(await askOf()).toEqual({ kind: 'cue', prompt: IDEA.prompt })

	// Filters: a lesson shows under Lessons, the hand-added idea under neither Lessons nor Readings.
	const lesson = await a.client.review.add({ id: randomUUID(), kind: 'lesson', prompt: 'Rest days?', answer: 'They count.' })
	expect((await a.client.review.next({})).items.map((i) => i.cardId)).toEqual([card.id, lesson.id])
	expect((await a.client.review.next({ filter: 'lessons' })).items.map((i) => i.cardId)).toEqual([lesson.id])
	expect(await a.client.review.next({ filter: 'readings' })).toEqual({ items: [], total: 0, minutes: 0 })

	const b = await newMember('B')
	const own = await b.client.review.add({ id: randomUUID(), kind: 'lesson', prompt: 'Say the number first', answer: 'Anchor high.' })
	expect((await b.client.review.next({})).items).toEqual([expect.objectContaining({ cardId: own.id, ask: { kind: 'self', prompt: 'Say the number first' }, answer: 'Anchor high.' })])
})

test('Count it as right turns a wrong written answer into good once, and the schedule is worked out again from before it', async () => {
	const a = await withKey('A')
	const { card, questionIds } = await ideaWithQuestions(a, ['explain'], 1)
	const wrong = written(card.id, questionIds[0]!, 'Something about bananas', 'sure')
	expect(await a.client.review.answer(wrong)).toMatchObject({ correct: false, rating: 'again', overridden: false })
	expect(await cardRow(card.id)).toMatchObject({ level: 0 })

	const counted = await a.client.review.override({ answerId: wrong.answerId })
	// As if the answer had been right: one level up from before it, back in 1 day.
	expect(counted).toMatchObject({ correct: true, rating: 'good', overridden: true })
	expect(daysUntil(counted.dueAt)).toBe(1)
	expect(await cardRow(card.id)).toMatchObject({ level: 2, due_at: counted.dueAt })
	const [row] = await sql<{ rating: string; correct: boolean; overridden_at: Date | null; confidence: string }>(
		'select rating, correct, overridden_at, confidence from review_log where answer_id = $1',
		[wrong.answerId],
	)
	expect(row).toMatchObject({ rating: 'good', correct: true, overridden_at: expect.any(Date), confidence: 'sure' })
	// Once per answer: asking again changes nothing.
	expect((await a.client.review.override({ answerId: wrong.answerId })).dueAt).toEqual(counted.dueAt)

	// Nothing to count for a self-rated answer or for I don't know, and only the member's own answers.
	const lesson = await a.client.review.add({ id: randomUUID(), kind: 'lesson', prompt: 'Rest days?', answer: 'They count.' })
	const self = rate(lesson.id, 'again')
	await a.client.review.answer(self)
	expect(await code(a.client.review.override({ answerId: self.answerId }))).toBe('BAD_REQUEST')
	await makeDue(card.id)
	const skipped = written(card.id, questionIds[0]!, null, null)
	await a.client.review.answer(skipped)
	expect(await code(a.client.review.override({ answerId: skipped.answerId }))).toBe('BAD_REQUEST')
	const b = await newMember('B')
	expect(await code(b.client.review.override({ answerId: wrong.answerId }))).toBe('NOT_FOUND')
})

test('Report a problem retires the question, and an answer to it stops counting', async () => {
	const a = await withKey('A')
	const { card, questionIds } = await ideaWithQuestions(a, ['explain', 'apply'], 1)
	const [explain, apply] = questionIds
	const before = await cardRow(card.id)
	const answer = written(card.id, explain!, RIGHT)
	await a.client.review.answer(answer)
	expect(await cardRow(card.id)).toMatchObject({ level: 2 })

	expect(await a.client.questions.report({ id: explain!, reason: 'wrong_answer', answerId: answer.answerId })).toEqual({ ok: true })
	expect((await sql('select report, retired_at from questions where id = $1', [explain]))[0]).toMatchObject({ report: 'wrong_answer', retired_at: expect.any(Date) })
	// The answer stays in the log as practice, and the card is back as it was: due now, at level 1.
	expect((await sql('select mode from review_log where answer_id = $1', [answer.answerId]))[0]).toEqual({ mode: 'practice' })
	expect(await cardRow(card.id)).toEqual(before)
	// The retired question is never asked again.
	expect((await a.client.review.next({})).items[0]!.ask).toMatchObject({ kind: 'question', questionId: apply })
	await a.client.questions.report({ id: apply!, reason: 'unclear' })
	expect((await a.client.review.next({})).items[0]!.ask).toEqual({ kind: 'cue', prompt: IDEA.prompt })

	const b = await newMember('B')
	expect(await code(b.client.questions.report({ id: apply!, reason: 'unclear' }))).toBe('NOT_FOUND')
})
