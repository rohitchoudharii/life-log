import { createHash } from 'node:crypto'
import { ORPCError } from '@orpc/server'
import { and, asc, desc, eq, isNull, or, type SQL, sql } from 'drizzle-orm'
import { asUser, type Tx } from '../db/client'
import { readingFiles, readings, sections } from '../db/schema'
import { bookKind } from '../import/book'
import { NOT_A_BOOK, NOT_A_LINK, normaliseUrl } from '../import/reading'
import { enqueueImport } from '../jobs'
import { authed } from '../orpc'

// Written out in full: inside a subquery Drizzle leaves column names unqualified, and `id` would
// then mean the section's own id.
const sectionCount = sql<number>`(select count(*)::int from sections where sections.reading_id = readings.id)`
const columns = { reading: readings, sectionCount }
type Row = { reading: typeof readings.$inferSelect; sectionCount: number }

const toReading = ({ reading: r, sectionCount }: Row) => ({
	id: r.id,
	title: r.title,
	author: r.author,
	sourceUrl: r.sourceUrl,
	requestedUrl: r.requestedUrl,
	status: r.status,
	error: r.error,
	wordCount: r.wordCount,
	sectionCount,
	createdAt: r.createdAt,
})

const notFound = () => new ORPCError('NOT_FOUND', { message: 'That reading does not exist. It may have been removed.' })

/** The reading a member means by this id: a link merged into another reading opens that one. */
async function resolve(tx: Tx, id: string): Promise<Row | undefined> {
	const [row] = await tx.select(columns).from(readings).where(eq(readings.id, id))
	return row?.reading.mergedInto ? resolve(tx, row.reading.mergedInto) : row
}

async function live(tx: Tx, id: string) {
	const row = await resolve(tx, id)
	if (!row || row.reading.deletedAt) throw notFound()
	return row
}

type NewReading = typeof readings.$inferInsert

/**
 * Adds a reading as importing, or finds the one the member already has: a retry with the same
 * id, or the same link or file (`same`). A removed reading is restored, and a failed one is
 * imported again. `created` runs only when the reading is new, in the same transaction. The
 * import job is queued after the commit, so it always finds the reading.
 */
async function addReading(userId: string, values: NewReading, same: SQL, created?: (tx: Tx) => Promise<unknown>) {
	const { row, queue } = await asUser(userId, async (tx) => {
		const [inserted] = await tx.insert(readings).values(values).onConflictDoNothing().returning()
		if (inserted) {
			await created?.(tx)
			return { row: { reading: inserted, sectionCount: 0 }, queue: true }
		}
		// An id that belongs to someone else is invisible here, so it can't be read or overwritten.
		const [found] = await tx
			.select({ id: readings.id })
			.from(readings)
			.where(or(eq(readings.id, values.id), same))
			.limit(1)
		const existing = found && (await resolve(tx, found.id))
		if (!existing) throw new ORPCError('CONFLICT', { message: 'That reading id is taken. Try again.' })
		const { reading } = existing
		const retry = reading.status === 'failed'
		if (!reading.deletedAt && !retry) return { row: existing, queue: false }
		const [updated] = await tx
			.update(readings)
			.set({ deletedAt: null, ...(retry && { status: 'importing' as const, error: null }) })
			.where(eq(readings.id, reading.id))
			.returning()
		return { row: { reading: updated!, sectionCount: existing.sectionCount }, queue: retry }
	})
	if (queue) await enqueueImport({ readingId: row.reading.id, userId })
	return toReading(row)
}

export const readingsRoutes = {
	add: authed.readings.add.handler(({ input, context }) => {
		const userId = context.user.id
		const url = normaliseUrl(input.url)
		if (!url) throw new ORPCError('BAD_REQUEST', { message: NOT_A_LINK })
		return addReading(userId, { id: input.id, userId, title: new URL(url).hostname, source: 'url', requestedUrl: url }, eq(readings.requestedUrl, url))
	}),

	addFile: authed.readings.addFile.handler(async ({ input, context }) => {
		const userId = context.user.id
		const data = Buffer.from(await input.file.arrayBuffer())
		const kind = bookKind(data)
		if (!kind) throw new ORPCError('BAD_REQUEST', { message: NOT_A_BOOK })
		const fileHash = createHash('sha256').update(data).digest('hex')
		const name = input.file.name.slice(0, 200) || (kind === 'pdf' ? 'Untitled.pdf' : 'Untitled.epub')
		return addReading(
			userId,
			{ id: input.id, userId, title: name.replace(/\.(epub|pdf)$/i, '') || name, source: kind === 'pdf' ? 'pdf_upload' : 'epub', fileHash },
			eq(readings.fileHash, fileHash),
			(tx) =>
				tx.insert(readingFiles).values({
					readingId: input.id,
					userId,
					name,
					contentType: kind === 'pdf' ? 'application/pdf' : 'application/epub+zip',
					size: data.length,
					data,
				}),
		)
	}),

	list: authed.readings.list.handler(({ context }) =>
		asUser(context.user.id, async (tx) => {
			const rows = await tx
				.select(columns)
				.from(readings)
				.where(and(isNull(readings.deletedAt), isNull(readings.mergedInto)))
				.orderBy(desc(readings.createdAt))
			return rows.map(toReading)
		}),
	),

	get: authed.readings.get.handler(({ input, context }) =>
		asUser(context.user.id, async (tx) => {
			const row = await live(tx, input.id)
			const contents = await tx
				.select({
					id: sections.id,
					position: sections.position,
					level: sections.level,
					title: sections.title,
					aiTitle: sections.aiTitle,
					wordCount: sections.wordCount,
				})
				.from(sections)
				.where(eq(sections.readingId, row.reading.id))
				.orderBy(asc(sections.position))
			return { ...toReading(row), contents }
		}),
	),

	section: authed.readings.section.handler(({ input, context }) =>
		asUser(context.user.id, async (tx) => {
			const [section] = await tx
				.select({
					id: sections.id,
					readingId: sections.readingId,
					position: sections.position,
					level: sections.level,
					title: sections.title,
					aiTitle: sections.aiTitle,
					blocks: sections.blocks,
				})
				.from(sections)
				.innerJoin(readings, eq(readings.id, sections.readingId))
				.where(and(eq(sections.id, input.id), isNull(readings.deletedAt)))
			if (!section) throw new ORPCError('NOT_FOUND', { message: 'That section does not exist. It may have been removed.' })
			return section
		}),
	),

	remove: authed.readings.remove.handler(({ input, context }) =>
		asUser(context.user.id, async (tx) => {
			const row = await live(tx, input.id)
			await tx.update(readings).set({ deletedAt: new Date() }).where(eq(readings.id, row.reading.id))
			return { ok: true as const }
		}),
	),

	restore: authed.readings.restore.handler(({ input, context }) =>
		asUser(context.user.id, async (tx) => {
			const row = await resolve(tx, input.id)
			if (!row?.reading.deletedAt) throw notFound()
			await tx.update(readings).set({ deletedAt: null }).where(eq(readings.id, row.reading.id))
			return toReading({ ...row, reading: { ...row.reading, deletedAt: null } })
		}),
	),
}
