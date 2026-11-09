import { and, eq, isNotNull, lt, or } from 'drizzle-orm'
import { type Job, type JobWithMetadata, PgBoss } from 'pg-boss'
import { ownerDb } from './db/client'
import { entries, invites, readings, sessions } from './db/schema'
import { env } from './env'
import { addChapterHeadings, importReading } from './import/reading'

const DAY = 24 * 60 * 60 * 1000
const ago = (days: number, now: Date) => new Date(now.getTime() - days * DAY)

/**
 * Deletes for good what nobody can reach any more: entries and readings removed more than 30
 * days ago (long past undo), sessions signed out or unused for 90 days, and invites expired 30
 * days ago.
 */
export async function cleanup(now = new Date()) {
	const removed = await ownerDb
		.delete(entries)
		.where(and(isNotNull(entries.deletedAt), lt(entries.deletedAt, ago(30, now))))
		.returning({ id: entries.id })
	const removedReadings = await ownerDb
		.delete(readings)
		.where(and(isNotNull(readings.deletedAt), lt(readings.deletedAt, ago(30, now))))
		.returning({ id: readings.id })
	const signedOut = await ownerDb
		.delete(sessions)
		.where(or(lt(sessions.revokedAt, ago(30, now)), lt(sessions.lastSeenAt, ago(90, now))))
		.returning({ id: sessions.id })
	const expired = await ownerDb
		.delete(invites)
		.where(lt(invites.expiresAt, ago(30, now)))
		.returning({ id: invites.id })
	return { entries: removed.length, readings: removedReadings.length, sessions: signedOut.length, invites: expired.length }
}

const boss = new PgBoss(env.DATABASE_OWNER_URL)
const IMPORT = 'import-reading'
type ImportJob = { readingId: string; userId: string }

/** Queues the import of a reading added as `importing`. At most one import per reading waits or runs. */
export const enqueueImport = (job: ImportJob) => boss.send(IMPORT, job, { singletonKey: job.readingId })

const HEADINGS = 'chapter-headings'
type HeadingsJob = { userId: string; readingId: string; chapter: number }

/** Queues AI headings for a long chapter the member opened. At most one waits or runs per chapter. */
export const enqueueChapterHeadings = (job: HeadingsJob) =>
	boss.send(HEADINGS, job, { singletonKey: `${job.readingId}:${job.chapter}` })

/** Background jobs run in Postgres, so there is nothing else to install or keep running. */
export async function startJobs() {
	boss.on('error', (error) => console.error('[jobs]', error))
	await boss.start()
	await boss.createQueue('cleanup')
	await boss.schedule('cleanup', '17 3 * * *')
	await boss.work('cleanup', async () => {
		console.log('[jobs] cleanup', await cleanup())
	})

	// Retries wait 10, 20 seconds: long enough for a site that didn't answer to come back. A
	// worker that dies mid-import (a restart) stops sending heartbeats, so its job is retried.
	// A big book takes up to 2 minutes to parse, plus its images; a web book's batch of pages,
	// fetched with a pause between them, can take longer.
	const options = { retryLimit: 2, retryDelay: 10, retryBackoff: true, expireInSeconds: 30 * 60, heartbeatSeconds: 30 }
	if (await boss.getQueue(IMPORT)) await boss.updateQueue(IMPORT, options)
	else await boss.createQueue(IMPORT, { policy: 'stately', ...options })
	await boss.work(IMPORT, { localConcurrency: 4, includeMetadata: true }, async ([job]: JobWithMetadata<ImportJob>[]) => {
		// A web book with pages left goes on in a new job, which the stately queue takes while this one is active.
		if (job && (await importReading(job.data, job.retryCount >= job.retryLimit)) === 'more') await enqueueImport(job.data)
	})
	// A chapter whose job fails keeps its length cut; the member can open it again to retry.
	if (!(await boss.getQueue(HEADINGS))) await boss.createQueue(HEADINGS, { policy: 'stately', retryLimit: 1, expireInSeconds: 5 * 60 })
	await boss.work(HEADINGS, { localConcurrency: 4 }, async ([job]: Job<HeadingsJob>[]) => {
		if (job) await addChapterHeadings(job.data)
	})
	// Readings left importing by a stop before their job was queued. The singleton key keeps a
	// reading whose job is still queued from getting a second one.
	const stuck = await ownerDb
		.select({ readingId: readings.id, userId: readings.userId })
		.from(readings)
		.where(eq(readings.status, 'importing'))
	await Promise.all(stuck.map(enqueueImport))
	return boss
}
