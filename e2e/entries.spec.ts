import { randomUUID } from 'node:crypto'
import { ORPCError } from '@orpc/client'
import { expect, test } from '@playwright/test'
import pg from 'pg'
import { newMember } from './api'
import { sql } from './db'
import { e2eEnv } from './env'

// These tests call the API directly, so one browser size is enough.
test.beforeEach(({}, info) => test.skip(info.project.name !== 'desktop', 'API only'))

const code = (promise: Promise<unknown>) =>
	promise.then(
		() => 'ok',
		(e: unknown) => (e instanceof ORPCError ? e.code : String(e)),
	)

test('an entry is saved with its pillar and jobs, and a retried create returns the first entry', async () => {
	const { client } = await newMember()
	const id = randomUUID()
	const set = { id, type: 'gym.set' as const, details: { exercise: 'Bench press', weightKg: 80, reps: 8 } }
	const created = await client.entries.create(set)
	expect(created).toMatchObject({ ...set, pillar: 'body', jobs: ['track'], text: null })

	const retry = await client.entries.create({ ...set, details: { ...set.details, reps: 3 } })
	expect(retry.details).toEqual(set.details)
	expect(await client.entries.list({})).toHaveLength(1)

	expect(await code(client.entries.create({ ...set, id: randomUUID(), details: { ...set.details, reps: 0 } }))).toBe(
		'BAD_REQUEST',
	)
})

test('the list is newest first and filters by pillar', async () => {
	const { client } = await newMember()
	const at = (h: number) => new Date(Date.UTC(2026, 10, 8, h))
	await client.entries.create({ id: randomUUID(), type: 'meal', details: { name: 'Shake', proteinG: 30 }, occurredAt: at(7) })
	await client.entries.create({ id: randomUUID(), type: 'mood', details: { score: 4 }, occurredAt: at(9) })
	await client.entries.create({ id: randomUUID(), type: 'sleep', details: { hours: 7 }, occurredAt: at(5) })

	expect((await client.entries.list({})).map((e) => e.type)).toEqual(['mood', 'meal', 'sleep'])
	expect((await client.entries.list({ pillar: 'body' })).map((e) => e.type)).toEqual(['meal', 'sleep'])
	expect((await client.entries.list({ before: at(8) })).map((e) => e.type)).toEqual(['meal', 'sleep'])
})

test('notes about people are encrypted in the database and readable only through the API', async () => {
	const { client } = await newMember()
	const note = 'Kabir is nervous about the new job in Pune'
	const meeting = await client.entries.create({ id: randomUUID(), type: 'meeting', details: { person: 'Kabir' }, text: note })
	expect(meeting.text).toBe(note)

	const [row] = await sql<{ text: string | null; text_ct: string }>('select text, text_ct from entries where id = $1', [
		meeting.id,
	])
	expect(row!.text).toBeNull()
	expect(row!.text_ct).not.toContain('Kabir')
	expect(row!.text_ct).toMatch(/^k1\./)

	// A ciphertext copied onto another entry doesn't decrypt there.
	const other = await client.entries.create({ id: randomUUID(), type: 'meeting', details: { person: 'Meera' }, text: 'x' })
	await sql('update entries set text_ct = $1 where id = $2', [row!.text_ct, other.id])
	expect(await code(client.entries.list({}))).toBe('INTERNAL_SERVER_ERROR')
	await sql('delete from entries where id = $1', [other.id])

	const updated = await client.entries.update({ id: meeting.id, text: 'Moved to Pune in January' })
	expect(updated.text).toBe('Moved to Pune in January')
	// A moment isn't about other people, so its text stays plain and searchable.
	const moment = await client.entries.create({ id: randomUUID(), type: 'moment', details: {}, text: 'Sky over the lake' })
	const [plain] = await sql<{ text: string }>('select text from entries where id = $1', [moment.id])
	expect(plain!.text).toBe('Sky over the lake')
})

test("a member can't see, change, remove or take over another member's entries", async () => {
	const a = await newMember('A')
	const b = await newMember('B')
	const entry = await a.client.entries.create({ id: randomUUID(), type: 'moment', details: {}, text: 'Private to A' })

	expect(await b.client.entries.list({})).toEqual([])
	expect(await code(b.client.entries.update({ id: entry.id, text: 'Taken' }))).toBe('NOT_FOUND')
	expect(await code(b.client.entries.remove({ id: entry.id }))).toBe('NOT_FOUND')
	expect(await code(b.client.entries.create({ id: entry.id, type: 'moment', details: {}, text: 'Taken' }))).toBe(
		'CONFLICT',
	)
	expect((await a.client.entries.list({}))[0]).toMatchObject({ id: entry.id, text: 'Private to A' })

	// The app account itself sees no entries unless a transaction names the member.
	const app = new pg.Client({ connectionString: e2eEnv.DATABASE_URL })
	await app.connect()
	expect((await app.query('select id from entries')).rowCount).toBe(0)
	await app.end()
})

test('removing an entry hides it, undo brings it back, and edits are checked', async () => {
	const { client } = await newMember()
	const entry = await client.entries.create({
		id: randomUUID(),
		type: 'gym.set',
		details: { exercise: 'Squat', weightKg: 100, reps: 5 },
	})
	await client.entries.remove({ id: entry.id })
	expect(await client.entries.list({})).toEqual([])
	expect(await code(client.entries.remove({ id: entry.id }))).toBe('NOT_FOUND')

	await client.entries.restore({ id: entry.id })
	expect(await client.entries.list({})).toHaveLength(1)

	const edited = await client.entries.update({ id: entry.id, details: { weightKg: 102.5 } })
	expect(edited.details).toEqual({ exercise: 'Squat', weightKg: 102.5, reps: 5 })
	expect(await code(client.entries.update({ id: entry.id, details: { reps: -1 } }))).toBe('BAD_REQUEST')
})

test('practice is logged on a member’s own skill, counts towards its week, keeps its name in step, turns one thing learned into a lesson card, and stays when the skill is archived', async () => {
	const { client } = await newMember()
	const piano = await client.skills.create({ id: randomUUID(), name: 'Piano', goal: 'Play the Bach prelude at 80 bpm', weeklyMinutes: 120 })
	expect(piano).toMatchObject({ name: 'Piano', goal: 'Play the Bach prelude at 80 bpm', weeklyMinutes: 120, archived: false, week: { minutes: 0, sessions: 0 }, sessions: 0, last: null })
	expect(await client.skills.create({ id: piano.id, name: 'Piano again' })).toEqual(piano)
	expect(await code(client.skills.create({ id: randomUUID(), name: 'piano' }))).toBe('CONFLICT')
	expect(await code(client.skills.create({ id: randomUUID(), name: 'Chess', weeklyMinutes: 0 }))).toBe('BAD_REQUEST')
	const practice = (details: Record<string, unknown>, more: { text?: string; occurredAt?: Date } = {}) =>
		client.entries.create({ id: randomUUID(), type: 'practice', details: { skillId: piano.id, minutes: 30, ...details } as never, ...more })

	// Minutes from 1 to 600, on the member's own skill only.
	expect(await code(practice({ minutes: 0 }))).toBe('BAD_REQUEST')
	expect(await code(practice({ minutes: 601 }))).toBe('BAD_REQUEST')
	const other = await newMember('Asha')
	const theirs = await other.client.skills.create({ id: randomUUID(), name: 'Chess' })
	expect(await code(practice({ skillId: theirs.id }))).toBe('BAD_REQUEST')
	expect(await code(other.client.skills.get({ id: piano.id }))).toBe('NOT_FOUND')

	// Last week's session doesn't count towards this week.
	await practice({ minutes: 20, nextTime: 'Left hand alone' }, { occurredAt: new Date(Date.now() - 8 * 86_400_000) })
	const first = await practice({ minutes: 30, workedOn: 'Left hand alone', feedback: 'A recording', nextTime: 'Even sixteenths at 70 bpm' }, { text: 'Slow practice finds the uneven notes.' })
	expect(first).toMatchObject({ pillar: 'mind', jobs: ['track', 'remember'], details: { skill: 'Piano', minutes: 30 }, text: 'Slow practice finds the uneven notes.' })
	await practice({ minutes: 45, workedOn: 'Even sixteenths at 70 bpm' })
	const [listed] = await client.skills.list()
	expect(listed).toMatchObject({ week: { minutes: 75, sessions: 2 }, sessions: 3, last: { minutes: 45, nextTime: null } })

	// One thing learned comes back like a lesson, asked by its skill; a session without one makes no card.
	expect(await sql('select prompt, answer, kind from cards where entry_id = $1', [first.id])).toEqual([
		{ prompt: "Practising Piano: what's the lesson?", answer: 'Slow practice finds the uneven notes.', kind: 'lesson' },
	])
	expect(await sql("select count(*)::int as n from cards where kind = 'lesson' and user_id = (select user_id from entries where id = $1)", [first.id])).toEqual([{ n: 1 }])

	// The skill's page: 8 weeks, this one last, and the trail newest first.
	const detail = await client.skills.get({ id: piano.id })
	expect(detail.weeks).toHaveLength(8)
	expect(detail.weeks.at(-1)).toMatchObject({ minutes: 75, sessions: 2 })
	expect(detail.weeks.reduce((n, w) => n + w.minutes, 0)).toBe(95)
	expect(detail.trail.map((t) => [t.minutes, t.workedOn, t.nextTime, t.learned])).toEqual([
		[45, 'Even sixteenths at 70 bpm', null, null],
		[30, 'Left hand alone', 'Even sixteenths at 70 bpm', 'Slow practice finds the uneven notes.'],
		[20, null, 'Left hand alone', null],
	])
	const progress = await client.progress.summary({ days: 84 })
	expect(progress.practice).toEqual([{ skillId: piano.id, name: 'Piano', weeklyMinutes: 120, weeks: expect.any(Array) }])
	expect(progress.practice[0]!.weeks.at(-1)!.minutes).toBe(75)

	// A new name shows on past sessions; an edit can't move a session to another skill.
	await client.skills.update({ id: piano.id, name: 'Piano (classical)', goal: '', weeklyMinutes: null })
	expect((await client.entries.list({})).filter((e) => e.type === 'practice').map((e) => e.type === 'practice' && e.details.skill)).toEqual(Array(3).fill('Piano (classical)'))
	const edited = await client.entries.update({ id: first.id, details: { skillId: theirs.id, minutes: 35 } })
	expect(edited.details).toMatchObject({ skillId: piano.id, minutes: 35 })
	expect((await client.skills.list())[0]).toMatchObject({ goal: null, weeklyMinutes: null })

	// Archived: gone from the list, its sessions kept, and no new ones until it is back.
	await client.skills.archive({ id: piano.id })
	expect(await client.skills.list()).toEqual([])
	expect((await client.entries.list({})).filter((e) => e.type === 'practice')).toHaveLength(3)
	expect(await code(practice({}))).toBe('BAD_REQUEST')
	expect((await client.skills.get({ id: piano.id })).archived).toBe(true)
	expect((await client.skills.restore({ id: piano.id })).sessions).toBe(3)
	expect(await code(practice({}))).toBe('ok')
})

test('entries need a session', async () => {
	const { client } = await newMember()
	await client.auth.signOut({})
	expect(await code(client.entries.list({}))).toBe('UNAUTHORIZED')
})
