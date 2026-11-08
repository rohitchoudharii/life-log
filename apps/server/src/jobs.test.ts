import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { ownerDb, ownerPool, pool } from './db/client'
import { prepareDatabase } from './db/prepare'
import { entries, invites, sessions, users } from './db/schema'
import { cleanup } from './jobs'

const DAY = 24 * 60 * 60 * 1000
const now = new Date('2026-11-08T03:17:00Z')
const ago = (days: number) => new Date(now.getTime() - days * DAY)

beforeAll(prepareDatabase)
afterAll(() => Promise.all([pool.end(), ownerPool.end()]))

it('deletes for good only what is past undo, signed out, or expired', async () => {
	const [user] = await ownerDb
		.insert(users)
		.values({ email: `cleanup-${randomUUID()}@example.com`, name: 'C' })
		.returning()
	const entry = (deletedAt: Date | null) => ({
		id: randomUUID(),
		userId: user!.id,
		type: 'mood',
		pillar: 'heart',
		occurredAt: ago(40),
		details: { score: 3 },
		deletedAt,
	})
	const keep = [entry(null), entry(ago(29))]
	const drop = [entry(ago(31))]
	await ownerDb.insert(entries).values([...keep, ...drop])

	const session = (lastSeenAt: Date, revokedAt: Date | null) => ({
		userId: user!.id,
		tokenHash: randomUUID(),
		label: 'test',
		lastSeenAt,
		revokedAt,
	})
	const s = await ownerDb
		.insert(sessions)
		.values([session(ago(1), null), session(ago(10), ago(29)), session(ago(40), ago(31)), session(ago(91), null)])
		.returning()
	await ownerDb.insert(invites).values([
		{ email: user!.email, tokenHash: randomUUID(), expiresAt: ago(29) },
		{ email: user!.email, tokenHash: randomUUID(), expiresAt: ago(31) },
	])

	const result = await cleanup(now)
	expect(result.entries).toBeGreaterThanOrEqual(1)

	const left = await ownerDb.select({ id: entries.id }).from(entries).where(eq(entries.userId, user!.id))
	expect(left.map((e) => e.id).sort()).toEqual(keep.map((e) => e.id).sort())
	const leftSessions = await ownerDb.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, user!.id))
	expect(leftSessions.map((x) => x.id).sort()).toEqual([s[0]!.id, s[1]!.id].sort())
	const leftInvites = await ownerDb.select().from(invites).where(eq(invites.email, user!.email))
	expect(leftInvites).toHaveLength(1)
})
