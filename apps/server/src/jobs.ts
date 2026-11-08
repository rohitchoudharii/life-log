import { and, isNotNull, lt, or } from 'drizzle-orm'
import { PgBoss } from 'pg-boss'
import { ownerDb } from './db/client'
import { entries, invites, sessions } from './db/schema'
import { env } from './env'

const DAY = 24 * 60 * 60 * 1000
const ago = (days: number, now: Date) => new Date(now.getTime() - days * DAY)

/**
 * Deletes for good what nobody can reach any more: entries removed more than 30 days ago (long
 * past undo), sessions signed out or unused for 90 days, and invites expired 30 days ago.
 */
export async function cleanup(now = new Date()) {
	const removed = await ownerDb
		.delete(entries)
		.where(and(isNotNull(entries.deletedAt), lt(entries.deletedAt, ago(30, now))))
		.returning({ id: entries.id })
	const signedOut = await ownerDb
		.delete(sessions)
		.where(or(lt(sessions.revokedAt, ago(30, now)), lt(sessions.lastSeenAt, ago(90, now))))
		.returning({ id: sessions.id })
	const expired = await ownerDb
		.delete(invites)
		.where(lt(invites.expiresAt, ago(30, now)))
		.returning({ id: invites.id })
	return { entries: removed.length, sessions: signedOut.length, invites: expired.length }
}

/** Background jobs run in Postgres, so there is nothing else to install or keep running. */
export async function startJobs() {
	const boss = new PgBoss(env.DATABASE_OWNER_URL)
	boss.on('error', (error) => console.error('[jobs]', error))
	await boss.start()
	await boss.createQueue('cleanup')
	await boss.schedule('cleanup', '17 3 * * *')
	await boss.work('cleanup', async () => {
		console.log('[jobs] cleanup', await cleanup())
	})
	return boss
}
