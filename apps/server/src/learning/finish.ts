import { defaultScheduler } from '@life-log-club/domain'
import { ORPCError } from '@orpc/server'
import { and, asc, desc, eq, isNotNull, isNull, sql, sum } from 'drizzle-orm'
import type { Tx } from '../db/client'
import { cards, entries, readings, readingTime, reviewLog } from '../db/schema'
import { hideLessonCard } from './lessons'

type Reading = typeof readings.$inferSelect

/** The most key lessons a finished reading keeps. */
export const MAX_LESSONS = 3

const lessonCards = (tx: Tx, entryId: string) =>
	tx
		.select({ id: cards.id, text: cards.answer })
		.from(cards)
		.where(and(eq(cards.entryId, entryId), isNull(cards.deletedAt)))
		.orderBy(asc(cards.position), asc(cards.createdAt))

/**
 * Marks a reading finished with a `reading.finished` entry, or finds the entry it already has,
 * and turns each new lesson into a lesson card on that entry, due at once. Card ids come from the
 * client, so a retried save adds nothing. The entry's text is every lesson, one a line.
 */
export async function finishReading(tx: Tx, reading: Reading, input: { entryId: string; lessons: { id: string; text: string }[] }) {
	const now = new Date()
	let entryId = reading.finishedAt ? reading.finishedEntryId : null
	if (!entryId) {
		await tx
			.insert(entries)
			.values({
				id: input.entryId,
				userId: reading.userId,
				type: 'reading.finished',
				pillar: 'mind',
				occurredAt: now,
				details: { readingId: reading.id, title: reading.title, ...(reading.author && { author: reading.author }) },
			})
			.onConflictDoNothing()
		const [entry] = await tx.select({ id: entries.id, type: entries.type }).from(entries).where(and(eq(entries.id, input.entryId), isNull(entries.deletedAt)))
		if (entry?.type !== 'reading.finished') throw new ORPCError('CONFLICT', { message: 'That entry id is taken. Try again.' })
		await tx.update(readings).set({ finishedAt: now, finishedEntryId: entry.id }).where(eq(readings.id, reading.id))
		entryId = entry.id
	}

	const kept = await lessonCards(tx, entryId)
	const fresh = input.lessons.filter((l) => !kept.some((k) => k.id === l.id))
	if (kept.length + fresh.length > MAX_LESSONS) throw new ORPCError('BAD_REQUEST', { message: `Keep up to ${MAX_LESSONS} key lessons from a reading.` })
	for (const [i, lesson] of fresh.entries()) {
		const n = kept.length + i + 1
		await tx
			.insert(cards)
			.values({
				id: lesson.id,
				userId: reading.userId,
				kind: 'lesson',
				entryId,
				readingId: reading.id,
				position: n,
				prompt: `Key lesson ${n} from “${reading.title}”: what was it?`,
				answer: lesson.text,
				state: defaultScheduler.initial(),
				// Saying a lesson in your own words is itself a study event, so it starts at once.
				startedAt: now,
			})
			.onConflictDoNothing()
	}
	const all = await lessonCards(tx, entryId)
	const [entry] = await tx
		.update(entries)
		.set({ text: all.map((l) => l.text).join('\n') || null, updatedAt: now })
		.where(eq(entries.id, entryId))
		.returning()
	return entry!
}

/** Undoes Finished: the entry is removed, its lesson cards hidden, and the reading is no longer finished. */
export async function unfinishReading(tx: Tx, reading: Reading) {
	if (!reading.finishedEntryId) return
	const at = new Date()
	await tx.update(entries).set({ deletedAt: at }).where(eq(entries.id, reading.finishedEntryId))
	await hideLessonCard(tx, reading.finishedEntryId, at)
	await tx.update(readings).set({ finishedAt: null, finishedEntryId: null }).where(eq(readings.id, reading.id))
}

/**
 * Keeps a reading in step when its `reading.finished` entry is removed (`at` a date) or restored
 * (`at` null): removing it means the reading is not finished; restoring finishes it again, at the
 * entry's time, unless it was finished again meanwhile.
 */
export async function onFinishedEntry(tx: Tx, entry: typeof entries.$inferSelect, at: Date | null) {
	if (entry.type !== 'reading.finished') return
	if (at) await tx.update(readings).set({ finishedAt: null, finishedEntryId: null }).where(eq(readings.finishedEntryId, entry.id))
	else
		await tx
			.update(readings)
			.set({ finishedAt: entry.occurredAt, finishedEntryId: entry.id })
			.where(and(eq(readings.id, (entry.details as { readingId: string }).readingId), isNull(readings.finishedAt)))
}

/** What a finished reading kept: time read, ideas in review, recall at each idea's last review, and its key lessons. */
export async function milestoneOf(tx: Tx, reading: Reading) {
	const [time] = await tx.select({ seconds: sum(readingTime.seconds).mapWith(Number) }).from(readingTime).where(eq(readingTime.readingId, reading.id))
	const [ideas] = await tx
		.select({ n: sql<number>`count(*)::int` })
		.from(cards)
		.where(and(eq(cards.readingId, reading.id), eq(cards.kind, 'idea'), isNull(cards.deletedAt), isNotNull(cards.startedAt)))
	const last = await tx
		.selectDistinctOn([reviewLog.cardId], { right: sql<boolean>`coalesce(${reviewLog.correct}, ${reviewLog.rating} <> 'again')` })
		.from(reviewLog)
		.innerJoin(cards, eq(cards.id, reviewLog.cardId))
		.where(and(eq(cards.readingId, reading.id), eq(cards.kind, 'idea'), isNull(cards.deletedAt), eq(reviewLog.mode, 'review'), isNull(reviewLog.overriddenAt)))
		.orderBy(reviewLog.cardId, desc(reviewLog.reviewedAt), desc(reviewLog.id))
	return {
		seconds: time?.seconds ?? 0,
		ideas: ideas?.n ?? 0,
		recall: { right: last.filter((l) => l.right).length, total: last.length },
		lessons: reading.finishedEntryId ? await lessonCards(tx, reading.finishedEntryId) : [],
	}
}
