import { ORPCError } from '@orpc/server'
import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import { asUser, type Tx } from '../db/client'
import { readings, recallAttempts, sections } from '../db/schema'
import { enqueueGrade, enqueueWriteSection } from '../jobs'
import { attemptView, sealDump, selfMark } from '../learning/recall'
import { chapterBatches } from '../learning/write-section'
import { authed } from '../orpc'

const NOT_FOUND = 'That recall check does not exist. Start it again from the reading.'

async function view(tx: Tx, id: string) {
	const attempt = await attemptView(tx, id)
	if (!attempt) throw new ORPCError('NOT_FOUND', { message: NOT_FOUND })
	return attempt
}

export const recallRoutes = {
	start: authed.recall.start.handler(async ({ input, context }) => {
		const userId = context.user.id
		const toWrite = await asUser(userId, async (tx) => {
			const [reading] = await tx.select({ id: readings.id }).from(readings).where(and(eq(readings.id, input.readingId), isNull(readings.deletedAt)))
			if (!reading) throw new ORPCError('NOT_FOUND', { message: 'That reading does not exist. It may have been removed.' })
			// Only this member's own sections of this reading, with words to recall.
			const shown = await tx
				.select({ id: sections.id, writeStatus: sections.writeStatus, wordCount: sections.wordCount })
				.from(sections)
				.where(and(inArray(sections.id, input.sectionIds), eq(sections.readingId, reading.id), eq(sections.kind, 'body')))
				.orderBy(asc(sections.position))
			if (shown.length !== new Set(input.sectionIds).size)
				throw new ORPCError('NOT_FOUND', { message: 'That section does not exist. It may have been removed.' })
			const [created] = await tx
				.insert(recallAttempts)
				.values({ id: input.id, userId, readingId: reading.id, sectionIds: shown.map((s) => s.id) })
				.onConflictDoNothing()
				.returning({ id: recallAttempts.id })
			if (!created) return []
			// Ideas not written yet are written now, while the member writes the dump.
			const waiting = shown.filter((s) => s.writeStatus === 'none' || s.writeStatus === 'paused' || s.writeStatus === 'failed')
			if (waiting.length)
				await tx
					.update(sections)
					.set({ writeStatus: 'queued', writeError: null })
					.where(
						inArray(
							sections.id,
							waiting.map((s) => s.id),
						),
					)
			// A whole chapter is written a few sections to a call, rather than one call per section.
			return shown.length > 1 ? chapterBatches(waiting) : waiting.map((s) => [s])
		})
		await Promise.all(
			toWrite.map(([first, ...rest]) => enqueueWriteSection({ userId, sectionId: first!.id, recall: true, ...(rest.length ? { with: rest.map((s) => s.id) } : {}) })),
		)
		return asUser(userId, (tx) => view(tx, input.id))
	}),

	submit: authed.recall.submit.handler(async ({ input, context }) => {
		const userId = context.user.id
		const sent = await asUser(userId, async (tx) => {
			const [attempt] = await tx.select({ status: recallAttempts.status }).from(recallAttempts).where(eq(recallAttempts.id, input.id)).for('update')
			if (!attempt) throw new ORPCError('NOT_FOUND', { message: NOT_FOUND })
			if (attempt.status !== 'open') return false
			await tx
				.update(recallAttempts)
				.set({ textCt: sealDump(input.id, input.text), source: input.source, status: 'grading', submittedAt: new Date() })
				.where(eq(recallAttempts.id, input.id))
			return true
		})
		if (sent) await enqueueGrade({ userId, attemptId: input.id })
		return asUser(userId, (tx) => view(tx, input.id))
	}),

	selfMark: authed.recall.selfMark.handler(({ input, context }) =>
		asUser(context.user.id, async (tx) => {
			await selfMark(tx, input.id, input.marks)
			return view(tx, input.id)
		}),
	),

	get: authed.recall.get.handler(({ input, context }) => asUser(context.user.id, (tx) => view(tx, input.id))),

	retry: authed.recall.retry.handler(async ({ input, context }) => {
		const userId = context.user.id
		const again = await asUser(userId, async (tx) => {
			const [row] = await tx
				.update(recallAttempts)
				.set({ status: 'grading', feedback: null })
				.where(and(eq(recallAttempts.id, input.id), eq(recallAttempts.status, 'failed')))
				.returning({ sectionIds: recallAttempts.sectionIds })
			if (!row) return null
			const failed = await tx
				.update(sections)
				.set({ writeStatus: 'queued', writeError: null })
				.where(and(inArray(sections.id, row.sectionIds), eq(sections.writeStatus, 'failed')))
				.returning({ id: sections.id })
			return failed.map((s) => s.id)
		})
		if (again) {
			await Promise.all(again.map((sectionId) => enqueueWriteSection({ userId, sectionId, recall: true })))
			await enqueueGrade({ userId, attemptId: input.id })
		}
		return asUser(userId, (tx) => view(tx, input.id))
	}),
}
