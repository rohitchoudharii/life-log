import type { WriteStatus } from '@life-log-club/domain'
import { and, eq, inArray, isNotNull, lt, or, sql } from 'drizzle-orm'
import { type Job, type JobWithMetadata, PgBoss } from 'pg-boss'
import { asUser, ownerDb } from './db/client'
import { aiKeys, books, cards, entries, invites, readings, recallAttempts, sections, sessions } from './db/schema'
import { env } from './env'
import { addChapterHeadings, importReading } from './import/reading'
import { type CueJob, writeLessonCue } from './learning/lessons'
import { type GradeJob, gradeAttempt } from './learning/recall'
import { type IdeaCueJob, writeIdeaCue } from './learning/saved-ideas'
import { type DefineWordJob, defineWord } from './learning/words'
import { type TopUpJob, topUpQuestions } from './learning/top-up'
import { membersToTune, tuneMember } from './learning/tune'
import { type WriteJob, writeKeyIdeas } from './learning/write-section'

const DAY = 24 * 60 * 60 * 1000
const ago = (days: number, now: Date) => new Date(now.getTime() - days * DAY)

/**
 * Deletes for good what nobody can reach any more: entries, readings, books and cards removed more
 * than 30 days ago (long past undo), sessions signed out or unused for 90 days, and invites expired 30
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
	const removedCards = await ownerDb
		.delete(cards)
		.where(and(isNotNull(cards.deletedAt), lt(cards.deletedAt, ago(30, now))))
		.returning({ id: cards.id })
	const signedOut = await ownerDb
		.delete(sessions)
		.where(or(lt(sessions.revokedAt, ago(30, now)), lt(sessions.lastSeenAt, ago(90, now))))
		.returning({ id: sessions.id })
	const expired = await ownerDb
		.delete(invites)
		.where(lt(invites.expiresAt, ago(30, now)))
		.returning({ id: invites.id })
	return { entries: removed.length, readings: removedReadings.length, books: removedBooks.length, cards: removedCards.length, sessions: signedOut.length, invites: expired.length }
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
// A chapter batch has its own key, so a job already waiting for its first section can't swallow
// it and leave the rest unwritten. If both run, the section lock lets only one store ideas.
export const enqueueWriteSection = (job: WriteJob) =>
	boss.send(WRITE, job, {
		singletonKey: job.rewrite ? `rewrite:${job.sectionId}` : job.with?.length ? `batch:${job.sectionId}` : job.sectionId,
		// The member is waiting on a recall or a rewrite they asked for.
		priority: job.recall || job.rewrite ? 10 : 0,
	})

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

const CUE = 'lesson-cue'

/** Queues the writing of a cue for a lesson logged without one. */
export const enqueueLessonCue = (job: CueJob) => boss.send(CUE, job, { singletonKey: job.entryId })

const TOP_UP = 'top-up-questions'
const TOP_UP_ALL = 'top-up-all'

/**
 * Queues a top-up of the member's questions a few minutes from now, after Review answers. Answers
 * in one sitting share the one queued job.
 */
export const enqueueTopUp = (userId: string) => boss.send(TOP_UP, { userId }, { singletonKey: userId, startAfter: 5 * 60 })

const IDEA_CUE = 'write-cue'

/** Queues the writing of a cue for an idea saved from a reading without a question. */
export const enqueueIdeaCue = (job: IdeaCueJob) => boss.send(IDEA_CUE, job, { singletonKey: job.cardId })

const DEFINE_WORD = 'define-word'
const TUNE = 'tune-schedule'
const TUNE_ALL = 'tune-all'

/** Queues the defining of a word added without a meaning. */
export const enqueueDefineWord = (job: DefineWordJob) => boss.send(DEFINE_WORD, job, { singletonKey: job.cardId })

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
	// A lesson whose cue isn't written keeps its date cue, so one retry is enough.
	if (!(await boss.getQueue(CUE))) await boss.createQueue(CUE, { policy: 'stately', retryLimit: 1, retryDelay: 30, expireInSeconds: 5 * 60 })
	await boss.work(CUE, { localConcurrency: 4 }, async ([job]: Job<CueJob>[]) => {
		if (job) await writeLessonCue(job.data)
	})
	// A card whose top-up fails is asked through its cue, so one retry is enough.
	if (!(await boss.getQueue(TOP_UP))) await boss.createQueue(TOP_UP, { policy: 'stately', retryLimit: 1, retryDelay: 60, expireInSeconds: 15 * 60 })
	await boss.work(TOP_UP, { localConcurrency: 2 }, async ([job]: Job<TopUpJob>[]) => {
		if (job) await topUpQuestions(job.data)
	})
	// Every 6 hours, each member with a key gets a top-up, so cards due soon have a fresh question waiting.
	if (!(await boss.getQueue(TOP_UP_ALL))) await boss.createQueue(TOP_UP_ALL)
	await boss.schedule(TOP_UP_ALL, '0 */6 * * *')
	await boss.work(TOP_UP_ALL, async () => {
		const members = await ownerDb.select({ userId: aiKeys.userId }).from(aiKeys)
		await Promise.all(members.map(({ userId }) => boss.send(TOP_UP, { userId }, { singletonKey: userId })))
	})
	// Like a lesson's, a saved idea keeps its fallback cue when this fails.
	if (!(await boss.getQueue(IDEA_CUE))) await boss.createQueue(IDEA_CUE, { policy: 'stately', retryLimit: 1, retryDelay: 30, expireInSeconds: 5 * 60 })
	await boss.work(IDEA_CUE, { localConcurrency: 4 }, async ([job]: Job<IdeaCueJob>[]) => {
		if (job) await writeIdeaCue(job.data)
	})
	// Once a month, each member with 1,000 answers or more gets their schedule tuned to their own memory.
	if (!(await boss.getQueue(TUNE))) await boss.createQueue(TUNE, { policy: 'stately', retryLimit: 1, retryDelay: 600, expireInSeconds: 15 * 60 })
	await boss.work(TUNE, { localConcurrency: 1 }, async ([job]: Job<{ userId: string }>[]) => {
		if (job) await tuneMember(job.data.userId)
	})
	if (!(await boss.getQueue(TUNE_ALL))) await boss.createQueue(TUNE_ALL)
	await boss.schedule(TUNE_ALL, '41 4 1 * *')
	await boss.work(TUNE_ALL, async () => {
		await Promise.all((await membersToTune()).map((userId) => boss.send(TUNE, { userId }, { singletonKey: userId })))
	})
	// A word that can't be defined asks the member for its meaning, so one retry is enough.
	if (!(await boss.getQueue(DEFINE_WORD))) await boss.createQueue(DEFINE_WORD, { policy: 'stately', retryLimit: 1, retryDelay: 30, expireInSeconds: 5 * 60 })
	await boss.work(DEFINE_WORD, { localConcurrency: 4 }, async ([job]: Job<DefineWordJob>[]) => {
		if (job) await defineWord(job.data)
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
