import { createHash } from 'node:crypto'
import { ORPCError } from '@orpc/server'
import { and, asc, desc, eq, inArray, isNull, or, type SQL, sql } from 'drizzle-orm'
import { blockText } from '@life-log-club/domain'
import { explainRequest, parseExplanation } from '@life-log-club/llm'
import { asUser, type Tx } from '../db/client'
import { aiKeys, bookChapters, books, cards, media, readingFiles, readings, readingTime, sections } from '../db/schema'
import { bookKind } from '../import/book'
import { type Captured, readCapture } from '../import/capture'
import { ExtractError } from '../import/extract'
import { readPaste } from '../import/paste'
import { NOT_A_BOOK, NOT_A_LINK, normaliseUrl, sectionRow } from '../import/reading'
import { enqueueChapterHeadings, enqueueImport, enqueueWriteSection } from '../jobs'
import { callAi } from '../learning/ai'
import { finishReading, milestoneOf, unfinishReading } from '../learning/finish'
import { ideasInUse } from '../learning/write-section'
import { addSampleReading } from '../seed/sample-reading'
import { putInBook } from './books'
import { toEntry } from './entries'
import { authed } from '../orpc'

const NOT_EXPLAINED = 'The explanation couldn’t be written just now. Try again in a moment.'

// Written out in full: inside a subquery Drizzle leaves column names unqualified, and `id` would
// then mean the section's own id.
const sectionCount = sql<number>`(select count(*)::int from sections where sections.reading_id = readings.id and sections.kind = 'body')`
// A web book has page rows only while it is imported.
const progress = sql<{ done: number; total: number } | null>`(select case when count(*) = 0 then null else json_build_object(
	'done', count(*) filter (where web_book_pages.blocks is not null or web_book_pages.error is not null), 'total', count(*)) end
	from web_book_pages where web_book_pages.reading_id = readings.id)`
// The live book the reading is a chapter of. A removed book's chapters are articles again.
const inBook = sql`from book_chapters join books on books.id = book_chapters.book_id
	where book_chapters.reading_id = readings.id and books.deleted_at is null`
const book = sql<{ id: string; title: string } | null>`(select json_build_object('id', books.id, 'title', books.title) ${inBook})`
const wordsRead = sql<number>`(select coalesce(sum(sections.word_count), 0)::int from sections
	where sections.reading_id = readings.id and sections.kind = 'body' and sections.read_at is not null)`
export const columns = { reading: readings, sectionCount, progress, book, wordsRead }
type Row = {
	reading: typeof readings.$inferSelect
	sectionCount: number
	wordsRead: number
	progress: { done: number; total: number } | null
	book: { id: string; title: string } | null
}

export const toReading = ({ reading: r, sectionCount, progress, book, wordsRead }: Row) => ({
	id: r.id,
	title: r.title,
	author: r.author,
	sourceUrl: r.sourceUrl,
	requestedUrl: r.requestedUrl,
	status: r.status,
	error: r.error,
	wordCount: r.wordCount,
	sectionCount,
	progress: r.status === 'importing' ? progress : null,
	partOfBook: r.partOfBook && { title: r.partOfBook.title, pages: r.partOfBook.pages },
	source: r.source,
	readAt: r.readAt,
	position: r.position,
	book,
	wordsRead,
	goalBy: r.goalBy,
	finishedAt: r.finishedAt,
	createdAt: r.createdAt,
})

const notFound = () => new ORPCError('NOT_FOUND', { message: 'That reading does not exist. It may have been removed.' })

/** The reading a member means by this id: a link merged into another reading opens that one. */
export async function resolve(tx: Tx, id: string): Promise<Row | undefined> {
	const [row] = await tx.select(columns).from(readings).where(eq(readings.id, id))
	return row?.reading.mergedInto ? resolve(tx, row.reading.mergedInto) : row
}

export async function live(tx: Tx, id: string) {
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
			return { row: { reading: inserted, sectionCount: 0, progress: null, book: null, wordsRead: 0 }, queue: true }
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
		return { row: { ...existing, reading: updated! }, queue: retry }
	})
	if (queue) await enqueueImport({ readingId: row.reading.id, userId })
	return toReading(row)
}

/** The kinds of reading a saved page can replace: articles, not books or files. */
const ARTICLE_SOURCES = ['url', 'web_capture', 'pdf_url'] as const

/**
 * The article the member already has from this page: added from the same link, or with the same
 * own address. A link merged into another reading means that reading.
 */
async function savedPage(tx: Tx, url: string, sourceUrl = url) {
	const [found] = await tx
		.select({ id: readings.id })
		.from(readings)
		.where(
			and(
				inArray(readings.source, [...ARTICLE_SOURCES]),
				or(eq(readings.requestedUrl, url), inArray(readings.sourceUrl, [url, sourceUrl])),
			),
		)
		.orderBy(sql`${readings.requestedUrl} = ${url} desc nulls last`, desc(readings.createdAt))
		.limit(1)
	const row = found && (await resolve(tx, found.id))
	// A chapter link merged into a whole web book is that book, which a saved page can't replace.
	return row && (ARTICLE_SOURCES as readonly string[]).includes(row.reading.source) ? row : undefined
}

/** Stores a saved page's sections and images, replacing whatever the reading held. */
async function storeCapture(tx: Tx, userId: string, readingId: string, page: Captured) {
	await tx.delete(sections).where(eq(sections.readingId, readingId))
	await tx.delete(media).where(eq(media.readingId, readingId))
	if (page.images.size)
		await tx.insert(media).values(
			[...page.images].map(([id, image]) => ({
				id,
				userId,
				readingId,
				contentType: 'image/webp',
				bytes: image.data.length,
				width: image.width,
				height: image.height,
				data: image.data,
			})),
		)
	await tx.insert(sections).values(page.sections.map((s, position) => sectionRow(userId, readingId, position, s)))
}

export const readingsRoutes = {
	capture: authed.readings.capture.handler(async ({ input, context }) => {
		const userId = context.user.id
		let page: Captured
		try {
			page = await readCapture(input)
		} catch (error) {
			if (error instanceof ExtractError) throw new ORPCError('BAD_REQUEST', { message: error.message })
			throw error
		}
		return asUser(userId, async (tx) => {
			const content = {
				title: page.title,
				author: page.author,
				publishedAt: page.publishedAt,
				source: 'web_capture' as const,
				sourceUrl: page.sourceUrl,
				status: 'ready' as const,
				error: null,
				wordCount: page.wordCount,
			}
			const saved = await savedPage(tx, page.url, page.sourceUrl)
			let readingId = saved?.reading.id
			if (readingId) {
				// Saving again always replaces the page, and the member reads it afresh.
				await tx.select({ id: readings.id }).from(readings).where(eq(readings.id, readingId)).for('update')
				await tx
					.update(readings)
					.set({ ...content, readAt: null, position: null, deletedAt: null, partOfBook: null })
					.where(eq(readings.id, readingId))
			} else {
				const [inserted] = await tx
					.insert(readings)
					.values({ id: input.id, userId, requestedUrl: page.url, ...content })
					.onConflictDoNothing()
					.returning({ id: readings.id })
				// The id is someone else's, or the link is already one of the member's books or files.
				if (!inserted) throw new ORPCError('CONFLICT', { message: 'Life Log Club already has this page as a book or a file. Open it there.' })
				readingId = inserted.id
			}
			await storeCapture(tx, userId, readingId, page)
			if (input.bookId) await putInBook(tx, userId, input.bookId, readingId)
			else await tx.delete(bookChapters).where(eq(bookChapters.readingId, readingId))
			const row = await live(tx, readingId)
			return { reading: toReading(row), updated: Boolean(saved) }
		})
	}),

	captureTarget: authed.readings.captureTarget.handler(({ input, context }) =>
		asUser(context.user.id, async (tx) => {
			const url = normaliseUrl(input.url)
			if (!url) throw new ORPCError('BAD_REQUEST', { message: NOT_A_LINK })
			const saved = await savedPage(tx, url)
			const reading = saved && !saved.reading.deletedAt ? saved : null
			let book = reading?.book ?? null
			if (!book) {
				// The book the member last added a chapter to from the same site.
				const host = (u: string | null) => (u ? (URL.parse(u)?.hostname.replace(/^www\./, '') ?? '') : '')
				const recent = await tx
					.select({ id: books.id, title: books.title, requestedUrl: readings.requestedUrl, sourceUrl: readings.sourceUrl })
					.from(bookChapters)
					.innerJoin(books, eq(books.id, bookChapters.bookId))
					.innerJoin(readings, eq(readings.id, bookChapters.readingId))
					.where(and(isNull(books.deletedAt), isNull(readings.deletedAt)))
					.orderBy(desc(bookChapters.addedAt))
					.limit(200)
				const same = recent.find((r) => [r.requestedUrl, r.sourceUrl].some((u) => host(u) === host(url)))
				book = same ? { id: same.id, title: same.title } : null
			}
			const words = book
				? (
						await tx
							.select({ words: readings.wordCount })
							.from(bookChapters)
							.innerJoin(readings, eq(readings.id, bookChapters.readingId))
							.where(and(eq(bookChapters.bookId, book.id), isNull(readings.deletedAt), eq(readings.status, 'ready')))
					)
						.map((r) => r.words)
						.sort((a, b) => a - b)
				: []
			return {
				readingId: reading?.reading.id ?? null,
				words: reading?.reading.status === 'ready' ? reading.reading.wordCount : null,
				book,
				bookWords: words.length ? words[Math.floor(words.length / 2)]! : null,
			}
		}),
	),

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

	addSample: authed.readings.addSample.handler(({ context }) =>
		asUser(context.user.id, async (tx) => ({ added: await addSampleReading(tx, context.user.id) })),
	),

	addText: authed.readings.addText.handler(({ input, context }) => {
		const userId = context.user.id
		let paste: ReturnType<typeof readPaste>
		try {
			paste = readPaste(input.text, input.title)
		} catch (error) {
			if (error instanceof ExtractError) throw new ORPCError('BAD_REQUEST', { message: error.message })
			throw error
		}
		return asUser(userId, async (tx) => {
			const [inserted] = await tx
				.insert(readings)
				.values({ id: input.id, userId, title: paste.title, source: 'paste', status: 'ready', wordCount: paste.wordCount })
				.onConflictDoNothing()
				.returning({ id: readings.id })
			if (inserted) await tx.insert(sections).values(paste.sections.map((s, position) => sectionRow(userId, input.id, position, s)))
			// A retry finds the reading the first try added. An id that belongs to someone else is invisible here.
			else if (!(await tx.select({ id: readings.id }).from(readings).where(eq(readings.id, input.id))).length)
				throw new ORPCError('CONFLICT', { message: 'That reading id is taken. Try again.' })
			return toReading(await live(tx, input.id))
		})
	}),

	addBook: authed.readings.addBook.handler(async ({ input, context }) => {
		const userId = context.user.id
		const chapter = await asUser(userId, (tx) => live(tx, input.id))
		const offer = chapter.reading.partOfBook
		// A retry after the chapter already opens the book: `live` followed it there.
		if (!offer && chapter.reading.source === 'web_book') return toReading(chapter)
		if (!offer) throw new ORPCError('BAD_REQUEST', { message: "This reading isn't part of a book Life Log Club can add." })
		const url = offer.contentsUrl
		const book = await addReading(
			userId,
			{ id: input.bookId, userId, title: offer.title, source: 'url', requestedUrl: url },
			or(eq(readings.requestedUrl, url), and(eq(readings.source, 'web_book'), eq(readings.sourceUrl, url)))!,
		)
		// The chapter becomes the book: its own copy goes, and its link opens the book from now on.
		await asUser(userId, async (tx) => {
			await tx.delete(sections).where(eq(sections.readingId, chapter.reading.id))
			await tx.delete(media).where(eq(media.readingId, chapter.reading.id))
			await tx.update(readings).set({ mergedInto: book.id, partOfBook: null }).where(eq(readings.id, chapter.reading.id))
		})
		return book
	}),

	list: authed.readings.list.handler(({ context }) =>
		asUser(context.user.id, async (tx) => {
			const rows = await tx
				.select(columns)
				.from(readings)
				// A book's chapters show inside the book, not on their own.
				.where(and(isNull(readings.deletedAt), isNull(readings.mergedInto), sql`not exists (select 1 ${inBook})`))
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
					kind: sections.kind,
					chapter: sections.chapter,
					readAt: sections.readAt,
				})
				.from(sections)
				.where(eq(sections.readingId, row.reading.id))
				.orderBy(asc(sections.position))
			return { ...toReading(row), contents }
		}),
	),

	section: authed.readings.section.handler(async ({ input, context }) => {
		const userId = context.user.id
		const [[section], [key]] = await asUser(userId, (tx) =>
			Promise.all([
				tx
					.select({
					id: sections.id,
					readingId: sections.readingId,
					position: sections.position,
					level: sections.level,
					title: sections.title,
					aiTitle: sections.aiTitle,
					kind: sections.kind,
					headingsPending: sections.headingsPending,
					chapter: sections.chapter,
					blocks: sections.blocks,
					notes: sections.notes,
					sourceUrl: sections.sourceUrl,
					writeStatus: sections.writeStatus,
					keyIdeas: sql<number>`(select count(*)::int from ${cards} where ${cards.sectionId} = ${sections.id} and ${cards.origin} = 'ai' and ${cards.deletedAt} is null)`,
					ideasInUse: ideasInUse(sections.id),
				})
					.from(sections)
					.innerJoin(readings, eq(readings.id, sections.readingId))
					.where(and(eq(sections.id, input.id), isNull(readings.deletedAt))),
				tx.select({ userId: aiKeys.userId }).from(aiKeys),
			]),
		)
		if (!section) throw new ORPCError('NOT_FOUND', { message: 'That section does not exist. It may have been removed.' })
		// The member is reading this chapter now, so it is worth an AI call for its headings. The
		// flag stays for a member with no key, so the headings come once they add one.
		const { chapter, ...out } = section
		const headingsPending = section.headingsPending && Boolean(key)
		if (headingsPending) await enqueueChapterHeadings({ userId, readingId: section.readingId, chapter })
		return { ...out, headingsPending }
	}),

	explain: authed.readings.explain.handler(async ({ input, context }) => {
		const userId = context.user.id
		const [section] = await asUser(userId, (tx) =>
			tx
				.select({ blocks: sections.blocks })
				.from(sections)
				.innerJoin(readings, eq(readings.id, sections.readingId))
				.where(and(eq(sections.id, input.sectionId), isNull(readings.deletedAt))),
		)
		if (!section) throw new ORPCError('NOT_FOUND', { message: 'That section does not exist. It may have been removed.' })
		const text = section.blocks.map(blockText).filter(Boolean).join('\n\n')
		// Asked for by the member, who is waiting, so like Recall it does not stop at the monthly budget.
		let reply: string | null
		try {
			reply = await callAi(userId, 'explain-passage', (model) => explainRequest(model, { section: text, passage: input.passage, kind: input.kind }))
		} catch {
			throw new ORPCError('SERVICE_UNAVAILABLE', { message: NOT_EXPLAINED })
		}
		if (reply === null) throw new ORPCError('BAD_REQUEST', { message: 'Add your own AI key in Settings to have passages explained.' })
		const explanation = parseExplanation(reply, text)
		if (!explanation) throw new ORPCError('SERVICE_UNAVAILABLE', { message: NOT_EXPLAINED })
		return explanation
	}),

	remove: authed.readings.remove.handler(({ input, context }) =>
		asUser(context.user.id, async (tx) => {
			const row = await live(tx, input.id)
			await tx.update(readings).set({ deletedAt: new Date() }).where(eq(readings.id, row.reading.id))
			return { ok: true as const }
		}),
	),

	markRead: authed.readings.markRead.handler(({ input, context }) =>
		asUser(context.user.id, async (tx) => {
			const row = await live(tx, input.id)
			const [section] = await tx
				.update(sections)
				.set({ readAt: sql`coalesce(${sections.readAt}, now())` })
				.where(and(eq(sections.id, input.sectionId), eq(sections.readingId, row.reading.id)))
				.returning({ position: sections.position })
			if (!section) throw new ORPCError('NOT_FOUND', { message: 'That section does not exist. It may have been removed.' })
			const [last] = await tx
				.select({ position: sections.position })
				.from(sections)
				.where(eq(sections.readingId, row.reading.id))
				.orderBy(desc(sections.position))
				.limit(1)
			if (section.position === last?.position)
				await tx
					.update(readings)
					.set({ readAt: new Date() })
					.where(and(eq(readings.id, row.reading.id), isNull(readings.readAt)))
			return { ok: true as const }
		}),
	),

	savePosition: authed.readings.savePosition.handler(({ input, context }) =>
		asUser(context.user.id, async (tx) => {
			const row = await live(tx, input.id)
			// A section of another reading would be a place this reading can't open.
			const [section] = await tx
				.select({ id: sections.id })
				.from(sections)
				.where(and(eq(sections.id, input.sectionId), eq(sections.readingId, row.reading.id)))
			if (!section) throw new ORPCError('NOT_FOUND', { message: 'That section does not exist. It may have been removed.' })
			await tx
				.update(readings)
				.set({ position: { sectionId: input.sectionId, block: input.block }, lastOpenedAt: new Date() })
				.where(eq(readings.id, row.reading.id))
			return { ok: true as const }
		}),
	),

	update: authed.readings.update.handler(({ input, context }) =>
		asUser(context.user.id, async (tx) => {
			const row = await live(tx, input.id)
			await tx.update(readings).set({ goalBy: input.goalBy }).where(eq(readings.id, row.reading.id))
			return toReading(await live(tx, row.reading.id))
		}),
	),

	finish: authed.readings.finish.handler(({ input, context }) =>
		asUser(context.user.id, async (tx) => {
			const row = await live(tx, input.id)
			// Locked, so two Finished taps can't make two entries.
			await tx.select({ id: readings.id }).from(readings).where(eq(readings.id, row.reading.id)).for('update')
			const current = await live(tx, row.reading.id)
			const entry = await finishReading(tx, current.reading, input)
			const after = await live(tx, row.reading.id)
			return { reading: toReading(after), entry: toEntry(entry), milestone: await milestoneOf(tx, after.reading) }
		}),
	),

	unfinish: authed.readings.unfinish.handler(({ input, context }) =>
		asUser(context.user.id, async (tx) => {
			const row = await live(tx, input.id)
			await unfinishReading(tx, row.reading)
			return toReading(await live(tx, row.reading.id))
		}),
	),

	milestone: authed.readings.milestone.handler(({ input, context }) =>
		asUser(context.user.id, async (tx) => milestoneOf(tx, (await live(tx, input.id)).reading)),
	),

	seen: authed.readings.seen.handler(async ({ input, context }) => {
		const userId = context.user.id
		const write = await asUser(userId, async (tx) => {
			const [before] = await tx
				.select({ firstSeenAt: sections.firstSeenAt, writeStatus: sections.writeStatus, kind: sections.kind, wordCount: sections.wordCount })
				.from(sections)
				.where(eq(sections.id, input.sectionId))
				.for('update')
			if (!before) throw new ORPCError('NOT_FOUND', { message: 'That section does not exist. It may have been removed.' })
			// The first heartbeat means the member really read here, so its key ideas are worth writing.
			const write = !before.firstSeenAt && before.writeStatus === 'none' && before.kind === 'body' && before.wordCount > 0
			const [section] = await tx
				.update(sections)
				.set({ firstSeenAt: sql`coalesce(${sections.firstSeenAt}, now())`, ...(write && { writeStatus: 'queued' as const }) })
				.where(eq(sections.id, input.sectionId))
				.returning({ readingId: sections.readingId })
			if (!section) throw new ORPCError('NOT_FOUND', { message: 'That section does not exist. It may have been removed.' })
			// Days are UTC until members can set their time zone.
			await tx
				.insert(readingTime)
				.values({ userId, readingId: section.readingId, day: sql`(now() at time zone 'utc')::date`, seconds: input.seconds })
				.onConflictDoUpdate({
					target: [readingTime.userId, readingTime.readingId, readingTime.day],
					set: { seconds: sql`${readingTime.seconds} + excluded.seconds` },
				})
			return write
		})
		if (write) await enqueueWriteSection({ userId, sectionId: input.sectionId })
		return { ok: true as const }
	}),

	restore: authed.readings.restore.handler(async ({ input, context }) => {
		const userId = context.user.id
		const row = await asUser(userId, async (tx) => {
			const row = await resolve(tx, input.id)
			if (!row?.reading.deletedAt) throw notFound()
			await tx.update(readings).set({ deletedAt: null }).where(eq(readings.id, row.reading.id))
			return row
		})
		// A web book stops fetching pages once it is removed; restoring it goes on from there.
		if (row.reading.status === 'importing') await enqueueImport({ readingId: row.reading.id, userId })
		return toReading({ ...row, reading: { ...row.reading, deletedAt: null } })
	}),
}
