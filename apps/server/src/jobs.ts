import type { WriteStatus } from '@life-log-club/domain'
import { and, eq, inArray, isNotNull, lt, or, sql } from 'drizzle-orm'
import { type Job, type JobWithMetadata, PgBoss } from 'pg-boss'
import { asUser, ownerDb } from './db/client'
import { books, entries, invites, readings, recallAttempts, sections, sessions } from './db/schema'
import { env } from './env'
import { addChapterHeadings, importReading } from './import/reading'
import { type GradeJob, gradeAttempt } from './learning/recall'
import { type WriteJob, writeKeyIdeas } from './learning/write-section'

const DAY = 24 * 60 * 60 * 1000
const ago = (days: number, now: Date) => new Date(now.getTime() - days * DAY)

/**
 * Deletes for good what nobody can reach any more: entries, readings and books removed more than 30
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
	const removedBooks = await ownerDb
		.delete(books)
		.where(and(isNotNull(books.deletedAt), lt(books.deletedAt, ago(30, now))))
		.returning({ id: books.id })
	const signedOut = await ownerDb
		.delete(sessions)
		.where(or(lt(sessions.revokedAt, ago(30, now)), lt(sessions.lastSeenAt, ago(90, now))))
		.returning({ id: sessions.id })
	const expired = await ownerDb
		.delete(invites)
		.where(lt(invites.expiresAt, ago(30, now)))
		.returning({ id: invites.id })
	return { entries: removed.length, readings: removedReadings.length, books: removedBooks.length, sessions: signedOut.length, invites: expired.length }
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

const WRITE = 'write-section'

/**
 * Queues the writing of a section's key ideas and questions. At most one waits and one runs per
 * section. Recall goes ahead of sections that were only seen, because the member is waiting.
 */
export const enqueueWriteSection = (job: WriteJob) => boss.send(WRITE, job, { singletonKey: job.sectionId, priority: job.recall ? 10 : 0 })

/** True when the section's writing has ended, one way or another. */
const sectionDone = ({ userId, sectionId }: WriteJob) =>
	asUser(userId, (tx) => tx.select({ writeStatus: sections.writeStatus }).from(sections).where(eq(sections.id, sectionId))).then(
		([s]) => !s || !['queued', 'writing'].includes(s.writeStatus),
	)

const GRADE = 'grade-recall'

/** Queues the grading of a brain dump. At most one waits and one runs per attempt. */
export const enqueueGrade = (job: GradeJob) => boss.send(GRADE, job, { singletonKey: job.attemptId, priority: 10 })

/**
 * Queues the grading of the attempts in this section's reading that wait on key ideas, once its
 * writing ends. The whole reading, because a short section is written with the next one.
 */
async function gradeWaitingOn(userId: string, sectionId: string) {
	const waiting = await asUser(userId, (tx) =>
		tx
			.select({ id: recallAttempts.id })
			.from(recallAttempts)
			.where(
				and(
					inArray(recallAttempts.status, ['waiting', 'grading']),
					sql`${recallAttempts.readingId} = (select ${sections.readingId} from ${sections} where ${sections.id} = ${sectionId})`,
				),
			),
	)
	await Promise.all(waiting.map((a) => enqueueGrade({ userId, attemptId: a.id })))
}

/**
 * Queues again the member's sections that wait in one of `statuses`: after they add a key
 * (`needs_key`) or raise the budget (`paused`).
 */
export async function requeueWaiting(userId: string, statuses: WriteStatus[]) {
	const waiting = await asUser(userId, (tx) =>
		tx.update(sections).set({ writeStatus: 'queued' }).where(inArray(sections.writeStatus, statuses)).returning({ id: sections.id }),
	)
	await Promise.all(waiting.map((s) => enqueueWriteSection({ userId, sectionId: s.id })))
}

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
	const writeOptions = { retryLimit: 2, retryDelay: 10, retryBackoff: true, expireInSeconds: 60 * 60, heartbeatSeconds: 30 }
	if (await boss.getQueue(WRITE)) await boss.updateQueue(WRITE, writeOptions)
	else await boss.createQueue(WRITE, { policy: 'stately', ...writeOptions })
	await boss.work(WRITE, { localConcurrency: 3, includeMetadata: true }, async ([job]: JobWithMetadata<WriteJob>[]) => {
		if (!job) return
		const lastTry = job.retryCount >= job.retryLimit
		try {
			await writeKeyIdeas(job.data, lastTry)
		} finally {
			// A dump may be waiting on these ideas, whether they were written or not.
			if (lastTry || (await sectionDone(job.data))) await gradeWaitingOn(job.data.userId, job.data.sectionId)
		}
	})
	const gradeOptions = { retryLimit: 2, retryDelay: 5, retryBackoff: true, expireInSeconds: 10 * 60 }
	if (await boss.getQueue(GRADE)) await boss.updateQueue(GRADE, gradeOptions)
	else await boss.createQueue(GRADE, { policy: 'stately', ...gradeOptions })
	await boss.work(GRADE, { localConcurrency: 4, includeMetadata: true }, async ([job]: JobWithMetadata<GradeJob>[]) => {
		if (job) await gradeAttempt(job.data, job.retryCount >= job.retryLimit)
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
