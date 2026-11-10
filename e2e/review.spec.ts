import { randomUUID } from 'node:crypto'
import { ORPCError } from '@orpc/client'
import { expect, test } from '@playwright/test'
import { newMember } from './api'
import { graduate, sql } from './db'
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

test('a new card is due at once, then comes back after 1, 2 and 3 days, then after a gap from FSRS', async () => {
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
	// The steps, then a gap from FSRS. Answered seconds apart, as here, FSRS has seen no time pass,
	// so its gap stays short; the scheduler's unit tests check the gaps with real days between answers.
	expect(gaps.slice(0, 3)).toEqual([1, 2, 3])
	expect(gaps[3]).toBeGreaterThanOrEqual(1)
	const [after] = await sql<{ state: { step: number | null; reps: number; memory: unknown } }>('select state from cards where id = $1', [card.id])
	expect(after!.state).toMatchObject({ step: null, reps: 4 })
	expect(after!.state.memory).not.toBeNull()

	const log = await sql<{ rating: string; ask: string; mode: string; scheduler: string; predicted_recall: number | null }>(
		'select rating, ask, mode, scheduler, predicted_recall from review_log where card_id = $1 order by reviewed_at',
		[card.id],
	)
	expect(log.map((r) => r.rating)).toEqual(['good', 'good', 'good', 'good'])
	// Self-rated answers from the queue, decided by the steps-then-FSRS scheduler, which predicts
	// recall from the second answer on (the first has nothing to predict from).
	expect(log[0]).toMatchObject({ ask: 'self', mode: 'review', scheduler: 'steps-fsrs-v1:FSRS-6', predicted_recall: null })
	for (const row of log.slice(1)) expect(row.predicted_recall).toBeGreaterThan(0.5)
})

test('the member’s review target sets the gap from FSRS: a higher target brings an idea back sooner', async () => {
	const { client } = await newMember()
	const add = () => client.review.add({ id: randomUUID(), kind: 'idea', prompt: 'Why space practice?', answer: 'Forgetting makes recall work harder.' })
	const [a, b] = [await add(), await add()]
	// Two cards with the same memory, a month since their last review.
	await graduate(a.id, 30, 30, 0)
	await graduate(b.id, 30, 30, 0)
	expect((await client.preferences.get()).desiredRetention).toBe(0.9)
	const at90 = daysUntil((await client.review.answer(rate(a.id, 'good'))).dueAt)
	await client.preferences.update({ desiredRetention: 0.95 })
	const at95 = daysUntil((await client.review.answer(rate(b.id, 'good'))).dueAt)
	// Fuzz moves a gap this long by 5% at most, far less than the difference between targets.
	expect(at90).toBeGreaterThan(60)
	expect(at95).toBeLessThan(at90 / 2)
	expect(await code(client.preferences.update({ desiredRetention: 0.99 }))).toBe('BAD_REQUEST')
})

test('Review serves the idea most likely forgotten first, not the one due longest', async () => {
	const { client } = await newMember()
	const add = (prompt: string) => client.review.add({ id: randomUUID(), kind: 'idea', prompt, answer: 'An answer.' })
	const strong = await add('Strong memory, due longest')
	const weak = await add('Weak memory, due a day ago')
	const fresh = await add('Never answered')
	// Both last reviewed 10 days ago: about 97% predicted recall for the strong one, 76% for the weak.
	await graduate(strong.id, 50, 10, 5)
	await graduate(weak.id, 2, 10, 1)

	const batch = await client.review.next({ limit: 2 })
	expect(batch.total).toBe(3)
	// A card never answered has nothing to recall from yet, so it comes first; the ranking covers
	// every due card, not just the oldest few.
	expect(batch.items.map((i) => i.cardId)).toEqual([fresh.id, weak.id])
	expect((await client.review.next({ limit: 20 })).items.map((i) => i.cardId)).toEqual([fresh.id, weak.id, strong.id])
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
	expect(await askOf()).toEqual({ kind: 'question', questionId: apply, type: 'short_answer', prompt: 'At apply: why does spacing help?', code: null, options: null, unit: null })
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
	// The new lesson has never been answered, so it comes before the idea answered three times.
	expect((await a.client.review.next({})).items.map((i) => i.cardId)).toEqual([lesson.id, card.id])
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

test('a finished reading follows its entry: removing it unfinishes, restoring finishes again; lessons count once, at most 3', async () => {
	const { client } = await newMember()
	const reading = await client.readings.addText({ id: randomUUID(), title: 'Peak', text: 'Practice at the edge of your skill, with fast feedback, makes experts.' })
	const entryId = randomUUID()
	const lesson = { id: randomUUID(), text: 'Practise at the edge.' }
	const first = await client.readings.finish({ id: reading.id, entryId, lessons: [lesson] })
	expect(first.entry).toMatchObject({ id: entryId, type: 'reading.finished', details: { readingId: reading.id, title: 'Peak' }, text: 'Practise at the edge.' })
	// A retried save, and a second Finished with another entry id, add nothing new.
	const again = await client.readings.finish({ id: reading.id, entryId: randomUUID(), lessons: [lesson] })
	expect(again.entry.id).toBe(entryId)
	expect(again.milestone.lessons).toEqual([lesson])
	const more = [1, 2, 3].map((n) => ({ id: randomUUID(), text: `Lesson ${n}.` }))
	expect(await code(client.readings.finish({ id: reading.id, entryId, lessons: more }))).toBe('BAD_REQUEST')
	expect((await client.readings.finish({ id: reading.id, entryId, lessons: more.slice(0, 2) })).milestone.lessons).toHaveLength(3)

	await client.entries.remove({ id: entryId })
	expect((await client.readings.get({ id: reading.id })).finishedAt).toBeNull()
	expect((await client.review.due({})).total).toBe(0)
	await client.entries.restore({ id: entryId })
	expect((await client.readings.get({ id: reading.id })).finishedAt).not.toBeNull()
	expect((await client.review.due({})).total).toBe(3)
	// Only Finished makes this entry.
	expect(await code(client.entries.create({ id: randomUUID(), type: 'reading.finished', details: { readingId: reading.id, title: 'Peak' } }))).toBe('BAD_REQUEST')
})

/** A pasted reading with two sections, ready at once. */
async function twoSections(client: Awaited<ReturnType<typeof newMember>>['client'], title = 'Peak') {
	const reading = await client.readings.addText({
		id: randomUUID(),
		title,
		text: '# The gold standard\n\nExperts see chunks where beginners see pieces.\n\n# Mental representations\n\nA representation lets you hold a whole pattern at once.',
	})
	const { contents } = await client.readings.get({ id: reading.id })
	return { reading, sections: contents }
}

test('a saved idea uses the member’s words and question, else the quote and a fallback cue, and is due in 1 day', async () => {
	const { client, user } = await newMember()
	const { reading, sections } = await twoSections(client)
	const [first, second] = sections
	const save = (quote: string, more: { prompt?: string; answer?: string; sectionId?: string } = {}) =>
		client.review.add({ id: randomUUID(), kind: 'idea', readingId: reading.id, sectionId: first!.id, quote, ...more })

	// Without a key or a question: the quote is the answer, and the cue names where it came from.
	const plain = await save('Experts see chunks\n where beginners see pieces.')
	expect(plain).toMatchObject({
		kind: 'idea',
		readingId: reading.id,
		sectionId: first!.id,
		quote: 'Experts see chunks where beginners see pieces.',
		answer: 'Experts see chunks where beginners see pieces.',
		prompt: `From Peak, ${first!.title}: what did you save here?`,
	})
	expect(daysUntil(plain.dueAt)).toBe(1)
	expect((await client.review.due({})).total).toBe(0)

	// The member's own words and question are used as they are.
	const own = await save('A representation lets you hold a whole pattern at once.', {
		sectionId: second!.id,
		answer: 'Experts hold the whole board in mind.',
		prompt: 'Why can a grandmaster recall a game at a glance?',
	})
	expect(own).toMatchObject({ answer: 'Experts hold the whole board in mind.', prompt: 'Why can a grandmaster recall a game at a glance?', sectionId: second!.id })

	// The same quote again, with other spacing, returns the first card.
	expect((await save(' Experts see chunks where beginners  see pieces. ')).id).toBe(plain.id)
	expect(await sql("select id from cards where user_id = $1 and kind = 'idea'", [user.id])).toHaveLength(2)
	expect(await sql("select 1 from ai_calls where user_id = $1 and purpose = 'write-cue'", [user.id])).toHaveLength(0)

	// Too long, or not from a reading, or not an idea: refused.
	const tooLong = await save('word '.repeat(201)).catch((e: unknown) => e)
	expect(tooLong).toBeInstanceOf(ORPCError)
	expect(JSON.stringify((tooLong as ORPCError<string, unknown>).data)).toContain('Pick one idea, not a page.')
	expect(await code(client.review.add({ id: randomUUID(), kind: 'idea', quote: 'A quote with no reading.' }))).toBe('BAD_REQUEST')
	expect(await code(client.review.add({ id: randomUUID(), kind: 'lesson', readingId: reading.id, sectionId: first!.id, quote: 'Q' }))).toBe('BAD_REQUEST')
	expect(await code(client.review.add({ id: randomUUID(), kind: 'idea', prompt: 'Only a question?' }))).toBe('BAD_REQUEST')

	// On Ideas, newest first, with where each came from; a removed reading takes its ideas with it.
	const listed = await client.review.list({ origin: 'member', kind: 'idea' })
	expect(listed.map((c) => [c.id, c.readingTitle, c.sectionTitle])).toEqual([
		[own.id, 'Peak', second!.title],
		[plain.id, 'Peak', first!.title],
	])
	await client.readings.remove({ id: reading.id })
	expect(await client.review.list({ origin: 'member' })).toEqual([])
})

test('a saved idea can be edited, removed and restored, and only by its member; lessons stay with their entry', async () => {
	const a = await newMember('A')
	const b = await newMember('B')
	const { reading, sections } = await twoSections(a.client)
	const idea = await a.client.review.add({ id: randomUUID(), kind: 'idea', readingId: reading.id, sectionId: sections[0]!.id, quote: 'Experts see chunks.' })

	const edited = await a.client.review.update({ id: idea.id, prompt: 'What do experts see?', answer: 'Chunks, not pieces.' })
	expect(edited).toMatchObject({ prompt: 'What do experts see?', answer: 'Chunks, not pieces.', dueAt: idea.dueAt })
	await a.client.review.remove({ id: idea.id })
	expect(await a.client.review.list({ readingId: reading.id })).toEqual([])
	expect(await code(a.client.review.update({ id: idea.id, prompt: 'Gone?' }))).toBe('NOT_FOUND')
	expect((await a.client.review.restore({ id: idea.id })).prompt).toBe('What do experts see?')
	expect(await a.client.review.list({ readingId: reading.id })).toHaveLength(1)

	// Another member can't save into this reading, or touch the idea.
	expect(await code(b.client.review.add({ id: randomUUID(), kind: 'idea', readingId: reading.id, sectionId: sections[0]!.id, quote: 'Mine now.' }))).toBe('NOT_FOUND')
	expect(await code(b.client.review.update({ id: idea.id, prompt: 'Changed?' }))).toBe('NOT_FOUND')
	expect(await code(b.client.review.remove({ id: idea.id }))).toBe('NOT_FOUND')
	expect(await b.client.review.list({})).toEqual([])
	// A section of another reading is not this reading's.
	const other = await twoSections(a.client, 'Moonwalking')
	expect(await code(a.client.review.add({ id: randomUUID(), kind: 'idea', readingId: reading.id, sectionId: other.sections[0]!.id, quote: 'Q.' }))).toBe('NOT_FOUND')
	// A lesson's card is edited through its entry, not here.
	const lesson = await a.client.review.add({ id: randomUUID(), kind: 'lesson', prompt: 'Salary talks?', answer: 'Anchor high.' })
	expect(await code(a.client.review.update({ id: lesson.id, answer: 'Changed.' }))).toBe('NOT_FOUND')
	expect(await code(a.client.review.remove({ id: lesson.id }))).toBe('NOT_FOUND')
})

test('a multiple-choice answer is graded in code against its key, with no AI key needed, and cannot be counted as right', async () => {
	const { client, user } = await newMember()
	const card = await client.review.add({ id: randomUUID(), kind: 'idea', prompt: 'Why space practice?', answer: 'Effortful recall lasts.' })
	const content = { prompt: 'Which holds?', options: ['Wrong one', 'Right one', 'Also wrong', 'Not this'], answerIndex: 1, explanation: 'Effort builds it.', whyWrong: ['W1', '', 'W3', 'W4'] }
	const [question] = await sql<{ id: string }>("insert into questions (user_id, card_id, type, level, content) values ($1, $2, 'mcq', 'apply', $3) returning id", [user.id, card.id, content])
	const answer = (response: Record<string, unknown>, answerId = randomUUID()) =>
		client.review.answer({ answerId, cardId: card.id, mode: 'practice', ask: 'question', questionId: question!.id, response, confidence: 'sure' })

	const wrong = await answer({ choice: 2 })
	expect(wrong).toMatchObject({
		correct: false,
		rating: 'again',
		reveal: { reference: 'Effort builds it.', choice: { options: content.options, right: 1, picked: 2, whyWrong: ['W1', '', 'W3', 'W4'] } },
	})
	expect((await answer({ choice: 1 })).correct).toBe(true)
	expect((await answer({ skipped: true })).reveal.choice?.picked).toBeNull()
	expect(await code(answer({ answer: 'Right one' }))).toBe('BAD_REQUEST')
	expect(await sql('select graded_by from review_log where card_id = $1', [card.id])).toEqual([{ graded_by: 'code' }, { graded_by: 'code' }, { graded_by: 'code' }])

	const [log] = await sql<{ answer_id: string }>('select answer_id from review_log where card_id = $1 and correct = false order by id limit 1', [card.id])
	expect(await code(client.review.override({ answerId: log!.answer_id }))).toBe('BAD_REQUEST')
	expect(await code(client.review.checklist({ cardId: card.id, questionId: question!.id }))).toBe('BAD_REQUEST')
})

test('a worked problem and a predicted output are checked in code without a key, can be counted as right, and the working is judged with a key', async () => {
	const { client, user } = await newMember()
	const card = await client.review.add({ id: randomUUID(), kind: 'idea', prompt: 'How do review gaps grow?', answer: 'Each gap is a multiple of the last.' })
	const add = (type: string, content: Record<string, unknown>) =>
		sql<{ id: string }>('insert into questions (user_id, card_id, type, level, content) values ($1, $2, $3, $4, $5) returning id', [user.id, card.id, type, 'apply', content]).then((r) => r[0]!.id)
	const worked = await add('worked_problem', {
		prompt: 'Gaps of 1, 3 and 9 days each triple. On which day is the next review?',
		answer: 27,
		unit: 'days',
		tolerance: 0,
		solution: 'The next gap is 18 days after day 9, so day 27.',
		steps: ['triple the previous interval', 'add the interval to the previous review'],
	})
	const output = await add('predict_output', { prompt: 'What does this print?', code: 'for (const n of [1, 2]) console.log(n * 3)', output: '3\n6', explanation: 'Each number is tripled.' })
	const answer = (questionId: string, response: Record<string, unknown>, c = client) =>
		c.review.answer({ answerId: randomUUID(), cardId: card.id, mode: 'practice', ask: 'question', questionId, response, confidence: 'sure' })

	// The number decides, in any common way of writing it, with the unit after it.
	expect(await answer(worked, { value: '27 days' })).toMatchObject({ correct: true, rating: 'good', reveal: { exact: { kind: 'number', expected: '27 days', given: '27 days' } } })
	const wrong = await answer(worked, { value: 'twenty-seven' })
	expect(wrong).toMatchObject({ correct: false, rating: 'again', reveal: { reference: 'The next gap is 18 days after day 9, so day 27.', exact: { expected: '27 days', given: 'twenty-seven' } } })
	expect((await answer(worked, { skipped: true })).reveal.exact).toEqual({ kind: 'number', expected: '27 days', given: null })
	// Output: spacing does not count, line breaks do.
	expect(await answer(output, { output: ' 3 \n6\n' })).toMatchObject({ correct: true, reveal: { exact: { kind: 'output', expected: '3\n6' } } })
	expect((await answer(output, { output: '3 6' })).correct).toBe(false)
	expect(await code(answer(output, { answer: '3 6' }))).toBe('BAD_REQUEST')
	expect(await sql('select graded_by from review_log where card_id = $1', [card.id])).toEqual(Array(5).fill({ graded_by: 'code' }))
	// Without a key, the working can't be judged; the number still decides.
	expect(await answer(worked, { value: '27', working: 'triple the last gap, add it to day 9' })).toMatchObject({ correct: true, rating: 'good', reveal: { points: [] } })

	// A right answer in a form the check did not expect can be counted as right.
	const [log] = await sql<{ answer_id: string }>("select answer_id from review_log where card_id = $1 and response->>'value' = 'twenty-seven'", [card.id])
	expect(await client.review.override({ answerId: log!.answer_id })).toMatchObject({ correct: true, overridden: true })
	// No points to tick, so no checklist.
	expect(await code(client.review.checklist({ cardId: card.id, questionId: worked }))).toBe('BAD_REQUEST')
	expect(await code(client.review.checklist({ cardId: card.id, questionId: output }))).toBe('BAD_REQUEST')

	// With a key, the working is judged against the key steps: clean working on a right answer is easy.
	await client.ai.saveKey({ provider: 'anthropic', apiKey: GOOD_ANTHROPIC_KEY })
	const judged = await answer(worked, { value: '27', working: 'Triple the previous interval to get 18, then add the interval to the previous review on day 9.' })
	expect(judged).toMatchObject({ correct: true, rating: 'easy', reveal: { points: [{ status: 'covered' }, { status: 'covered' }] } })
	const [last] = await sql<{ graded_by: string }>('select graded_by from review_log where card_id = $1 order by id desc limit 1', [card.id])
	expect(last!.graded_by).toBe('ai')
})

test('Rewrite key ideas replaces ideas none of which is in use; once one is answered only questions can be rewritten, and never on Quick or without a key', async () => {
	const { client, user } = await newMember()
	await client.ai.saveKey({ provider: 'anthropic', apiKey: GOOD_ANTHROPIC_KEY })
	const words = 'Spaced practice beats cramming because effortful recall strengthens memory traces. Sleep after study moves new memories into lasting storage overnight. Feedback soon after a mistake helps the learner fix it before it sets.'
	const reading = await client.readings.addText({ id: randomUUID(), title: 'Habits', text: `# Learning\n\n${words} ${words}` })
	const [section] = (await client.readings.get({ id: reading.id })).contents
	const status = () => sql<{ write_status: string }>('select write_status from sections where id = $1', [section!.id]).then((r) => r[0]!.write_status)
	const ideaIds = () => sql<{ id: string }>("select id from cards where section_id = $1 and origin = 'ai' order by position", [section!.id]).then((r) => r.map((c) => c.id))
	await client.readings.seen({ sectionId: section!.id, seconds: 30 })
	await expect.poll(status, { timeout: 15_000 }).toBe('ready')
	const first = await ideaIds()
	expect(first.length).toBeGreaterThan(0)
	expect((await client.readings.section({ id: section!.id })).ideasInUse).toBe(false)

	// None in use: the key ideas are written again, as new cards.
	await client.questions.rewrite({ sectionId: section!.id, ideas: true })
	await expect.poll(status, { timeout: 15_000 }).toBe('ready')
	const second = await ideaIds()
	expect(second.length).toBeGreaterThan(0)
	expect(second.filter((id) => first.includes(id))).toEqual([])

	// One answered: its ideas stay, and only questions can be rewritten.
	await client.review.answer({ answerId: randomUUID(), cardId: second[0]!, mode: 'recall', ask: 'cue', response: { skipped: true }, confidence: null })
	expect((await client.readings.section({ id: section!.id })).ideasInUse).toBe(true)
	expect(await code(client.questions.rewrite({ sectionId: section!.id, ideas: true }))).toBe('CONFLICT')
	await client.questions.rewrite({ sectionId: section!.id })
	await expect.poll(status, { timeout: 15_000 }).toBe('ready')
	expect(await ideaIds()).toEqual(second)
	expect(await sql('select card_id from review_log where user_id = $1', [user.id])).toEqual([{ card_id: second[0] }])

	// Quick writes no questions, so there is nothing to rewrite; another member and a member without a key can't.
	await client.preferences.update({ questionAmount: 'quick' })
	expect(await code(client.questions.rewrite({ sectionId: section!.id }))).toBe('BAD_REQUEST')
	const other = await newMember('B')
	expect(await code(other.client.questions.rewrite({ sectionId: section!.id }))).toBe('NOT_FOUND')
	const own = await other.client.readings.addText({ id: randomUUID(), text: `# Notes\n\n${words}` })
	const [ownSection] = (await other.client.readings.get({ id: own.id })).contents
	expect(await code(other.client.questions.rewrite({ sectionId: ownSection!.id }))).toBe('BAD_REQUEST')
})
