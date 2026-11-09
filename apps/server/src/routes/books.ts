import { ORPCError } from '@orpc/server'
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm'
import { asUser, type Tx } from '../db/client'
import { bookChapters, books, readings } from '../db/schema'
import { authed } from '../orpc'
import { columns, live as liveReading, toReading } from './readings'

// Chapters whose reading was removed are left out until it is restored.
const chapters = sql`from book_chapters c join readings r on r.id = c.reading_id where c.book_id = books.id and r.deleted_at is null`
const bookColumns = {
	book: books,
	chapterCount: sql<number>`(select count(*)::int ${chapters})`,
	readCount: sql<number>`(select count(*)::int ${chapters} and r.read_at is not null)`,
	continueId: sql<string | null>`(select c.reading_id ${chapters} and r.read_at is null and r.status = 'ready' order by c.position limit 1)`,
}
type BookRow = { book: typeof books.$inferSelect; chapterCount: number; readCount: number; continueId: string | null }

const toBook = ({ book: b, chapterCount, readCount, continueId }: BookRow) => ({
	id: b.id,
	title: b.title,
	author: b.author,
	chapterCount,
	readCount,
	continueId,
	createdAt: b.createdAt,
})

export const NOT_AN_ARTICLE = 'Only articles can be chapters of a book, not a file or another book.'
/** Articles from a link, and pages the extension saved. */
const ARTICLES = new Set(['url', 'web_capture'])
const notFound = () => new ORPCError('NOT_FOUND', { message: 'That book does not exist. It may have been removed.' })

async function liveBook(tx: Tx, id: string) {
	const [row] = await tx
		.select(bookColumns)
		.from(books)
		.where(and(eq(books.id, id), isNull(books.deletedAt)))
	if (!row) throw notFound()
	return row
}

async function withChapters(tx: Tx, id: string) {
	const book = await liveBook(tx, id)
	const rows = await tx
		.select(columns)
		.from(bookChapters)
		.innerJoin(readings, eq(readings.id, bookChapters.readingId))
		.where(and(eq(bookChapters.bookId, id), isNull(readings.deletedAt)))
		.orderBy(asc(bookChapters.position), asc(bookChapters.addedAt))
	return { ...toBook(book), chapters: rows.map(toReading) }
}

/**
 * Puts a reading at the end of a live book, or moves it there from another book. A reading already
 * in this book stays where it is. Only articles; `bookId` and `readingId` must be the member's.
 */
export async function putInBook(tx: Tx, userId: string, bookId: string, readingId: string) {
	await liveBook(tx, bookId)
	await tx.select({ id: books.id }).from(books).where(eq(books.id, bookId)).for('update')
	// A link merged into another reading is that reading.
	const { reading } = await liveReading(tx, readingId)
	if (!ARTICLES.has(reading.source)) throw new ORPCError('BAD_REQUEST', { message: NOT_AN_ARTICLE })
	const [current] = await tx.select().from(bookChapters).where(eq(bookChapters.readingId, reading.id))
	if (current?.bookId === bookId) return
	const [{ next } = { next: 0 }] = await tx
		.select({ next: sql<number>`coalesce(max(${bookChapters.position}) + 1, 0)::int` })
		.from(bookChapters)
		.where(eq(bookChapters.bookId, bookId))
	await tx
		.insert(bookChapters)
		.values({ readingId: reading.id, bookId, userId, position: next })
		.onConflictDoUpdate({ target: bookChapters.readingId, set: { bookId, position: next, addedAt: new Date() } })
}

/** The chapter row of a reading, with its book locked so moves in it happen one at a time. */
async function chapterOf(tx: Tx, readingId: string) {
	const [chapter] = await tx.select().from(bookChapters).where(eq(bookChapters.readingId, readingId))
	if (!chapter) throw new ORPCError('NOT_FOUND', { message: 'That article is not in a book.' })
	await tx.select({ id: books.id }).from(books).where(eq(books.id, chapter.bookId)).for('update')
	return chapter
}

export const booksRoutes = {
	create: authed.books.create.handler(({ input, context }) =>
		asUser(context.user.id, async (tx) => {
			await tx.insert(books).values({ id: input.id, userId: context.user.id, title: input.title }).onConflictDoNothing()
			// An id that belongs to someone else is invisible here, so it can't be read or overwritten.
			const [row] = await tx.select(bookColumns).from(books).where(eq(books.id, input.id))
			if (!row) throw new ORPCError('CONFLICT', { message: 'That book id is taken. Try again.' })
			return toBook(row)
		}),
	),

	list: authed.books.list.handler(({ context }) =>
		asUser(context.user.id, async (tx) => {
			const rows = await tx.select(bookColumns).from(books).where(isNull(books.deletedAt)).orderBy(desc(books.createdAt))
			return rows.map(toBook)
		}),
	),

	get: authed.books.get.handler(({ input, context }) => asUser(context.user.id, (tx) => withChapters(tx, input.id))),

	rename: authed.books.rename.handler(({ input, context }) =>
		asUser(context.user.id, async (tx) => {
			await liveBook(tx, input.id)
			await tx.update(books).set({ title: input.title }).where(eq(books.id, input.id))
			return toBook(await liveBook(tx, input.id))
		}),
	),

	remove: authed.books.remove.handler(({ input, context }) =>
		asUser(context.user.id, async (tx) => {
			await liveBook(tx, input.id)
			await tx.update(books).set({ deletedAt: new Date() }).where(eq(books.id, input.id))
			return { ok: true as const }
		}),
	),

	restore: authed.books.restore.handler(({ input, context }) =>
		asUser(context.user.id, async (tx) => {
			const [found] = await tx.select({ id: books.id }).from(books).where(eq(books.id, input.id))
			if (!found) throw notFound()
			await tx.update(books).set({ deletedAt: null }).where(eq(books.id, input.id))
			return toBook(await liveBook(tx, input.id))
		}),
	),

	addChapter: authed.books.addChapter.handler(({ input, context }) =>
		asUser(context.user.id, async (tx) => {
			await putInBook(tx, context.user.id, input.bookId, input.readingId)
			return withChapters(tx, input.bookId)
		}),
	),

	removeChapter: authed.books.removeChapter.handler(({ input, context }) =>
		asUser(context.user.id, async (tx) => {
			await tx.delete(bookChapters).where(eq(bookChapters.readingId, input.readingId))
			return { ok: true as const }
		}),
	),

	moveChapter: authed.books.moveChapter.handler(({ input, context }) =>
		asUser(context.user.id, async (tx) => {
			const chapter = await chapterOf(tx, input.readingId)
			// `to` counts the chapters the member sees, so removed readings are left out.
			const order = await tx
				.select({ readingId: bookChapters.readingId })
				.from(bookChapters)
				.innerJoin(readings, eq(readings.id, bookChapters.readingId))
				.where(and(eq(bookChapters.bookId, chapter.bookId), isNull(readings.deletedAt)))
				.orderBy(asc(bookChapters.position), asc(bookChapters.addedAt))
			const ids = order.map((c) => c.readingId).filter((id) => id !== input.readingId)
			ids.splice(Math.min(input.to, ids.length), 0, input.readingId)
			for (const [position, readingId] of ids.entries())
				await tx.update(bookChapters).set({ position }).where(eq(bookChapters.readingId, readingId))
			return withChapters(tx, chapter.bookId)
		}),
	),
}
