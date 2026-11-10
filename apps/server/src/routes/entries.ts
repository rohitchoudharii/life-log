import { ENTRY_TYPES, EntryData, type EntryType } from '@life-log-club/domain'
import { ORPCError } from '@orpc/server'
import { and, desc, eq, isNotNull, isNull, lt } from 'drizzle-orm'
import { decrypt, encrypt } from '../crypto'
import { asUser, type Tx } from '../db/client'
import { entries } from '../db/schema'
import { enqueueLessonCue } from '../jobs'
import { onFinishedEntry } from '../learning/finish'
import { addLessonCard, hideLessonCard, updateLessonCard } from '../learning/lessons'
import { authed } from '../orpc'

type Row = typeof entries.$inferSelect

const textContext = (id: string) => `entries.text:${id}`

/** Where an entry's text is stored: encrypted for types whose text is about other people. */
function storeText(type: EntryType, id: string, text: string | null | undefined) {
	const value = text?.trim() || null
	if (ENTRY_TYPES[type].privateText) return { text: null, textCt: value && encrypt(value, textContext(id)) }
	return { text: value, textCt: null }
}

export function toEntry(row: Row) {
	const type = row.type as EntryType
	return {
		...EntryData.parse({ type, details: row.details }),
		id: row.id,
		pillar: ENTRY_TYPES[type].pillar,
		jobs: ENTRY_TYPES[type].jobs,
		occurredAt: row.occurredAt,
		text: row.textCt ? decrypt(row.textCt, textContext(row.id)) : row.text,
		createdAt: row.createdAt,
	}
}

/** A lesson is remembered by its text, so it can't be empty. */
function checkLessonText(type: EntryType, text: string | null | undefined) {
	if (type === 'lesson' && !text?.trim()) throw new ORPCError('BAD_REQUEST', { message: 'Write what you learned, then save.' })
}

const notFound = () => new ORPCError('NOT_FOUND', { message: 'That entry does not exist.' })

async function find(tx: Tx, id: string, removed: boolean) {
	const [row] = await tx
		.select()
		.from(entries)
		.where(and(eq(entries.id, id), removed ? isNotNull(entries.deletedAt) : isNull(entries.deletedAt)))
	if (!row) throw notFound()
	return row
}

export const entriesRoutes = {
	create: authed.entries.create.handler(async ({ input, context }) => {
		if (input.type === 'reading.finished') throw new ORPCError('BAD_REQUEST', { message: 'Mark a reading finished from the reading itself.' })
		checkLessonText(input.type, input.text)
		const { entry, needsCue } = await asUser(context.user.id, async (tx) => {
			const [created] = await tx
				.insert(entries)
				.values({
					id: input.id,
					userId: context.user.id,
					type: input.type,
					pillar: ENTRY_TYPES[input.type].pillar,
					occurredAt: input.occurredAt ?? new Date(),
					details: input.details,
					...storeText(input.type, input.id, input.text),
				})
				.onConflictDoNothing()
				.returning()
			if (created) {
				const needsCue = created.type === 'lesson' && input.remember !== false && (await addLessonCard(tx, created))
				return { entry: toEntry(created), needsCue }
			}
			// A retry of a create that already happened returns the first entry. An id that
			// belongs to someone else is invisible here, so it can't be read or overwritten.
			const [existing] = await tx.select().from(entries).where(eq(entries.id, input.id))
			if (!existing) throw new ORPCError('CONFLICT', { message: 'That entry id is taken. Try again.' })
			return { entry: toEntry(existing), needsCue: false }
		})
		if (needsCue) await enqueueLessonCue({ userId: context.user.id, entryId: entry.id })
		return entry
	}),

	list: authed.entries.list.handler(({ input, context }) =>
		asUser(context.user.id, async (tx) => {
			const rows = await tx
				.select()
				.from(entries)
				.where(
					and(
						isNull(entries.deletedAt),
						input.pillar && eq(entries.pillar, input.pillar),
						input.before && lt(entries.occurredAt, input.before),
					),
				)
				.orderBy(desc(entries.occurredAt), desc(entries.createdAt))
				.limit(input.limit)
			return rows.map(toEntry)
		}),
	),

	update: authed.entries.update.handler(({ input, context }) =>
		asUser(context.user.id, async (tx) => {
			const row = await find(tx, input.id, false)
			const type = row.type as EntryType
			const parsed = EntryData.safeParse({ type, details: { ...row.details, ...input.details } })
			if (!parsed.success) throw new ORPCError('BAD_REQUEST', { message: 'Those details are not valid for this entry.' })
			if (input.text !== undefined) checkLessonText(type, input.text)
			const [updated] = await tx
				.update(entries)
				.set({
					details: parsed.data.details,
					occurredAt: input.occurredAt ?? row.occurredAt,
					...(input.text !== undefined && storeText(type, row.id, input.text)),
					updatedAt: new Date(),
				})
				.where(eq(entries.id, row.id))
				.returning()
			if (type === 'lesson') await updateLessonCard(tx, row, updated!)
			return toEntry(updated!)
		}),
	),

	remove: authed.entries.remove.handler(({ input, context }) =>
		asUser(context.user.id, async (tx) => {
			const row = await find(tx, input.id, false)
			const at = new Date()
			await tx.update(entries).set({ deletedAt: at }).where(eq(entries.id, row.id))
			await hideLessonCard(tx, row.id, at)
			await onFinishedEntry(tx, row, at)
			return { ok: true as const }
		}),
	),

	restore: authed.entries.restore.handler(({ input, context }) =>
		asUser(context.user.id, async (tx) => {
			const row = await find(tx, input.id, true)
			const [restored] = await tx.update(entries).set({ deletedAt: null }).where(eq(entries.id, row.id)).returning()
			await hideLessonCard(tx, row.id, null)
			await onFinishedEntry(tx, row, null)
			return toEntry(restored!)
		}),
	),
}
