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

test('entries need a session', async () => {
	const { client } = await newMember()
	await client.auth.signOut({})
	expect(await code(client.entries.list({}))).toBe('UNAUTHORIZED')
})
