import { blockLinks, orderForTest, parseMarkdown, QUESTION_INTENSITIES, QUESTION_STYLES, splitSections, toPrompt, type Block, type ContentSourceType, type PointStatus } from '@life-log-club/core'
import { and, arrayOverlaps, asc, count, desc, eq, gt, inArray, isNotNull, isNull, ne, notLike, or, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import { REVIEW_PROMPT_VERSION } from '@life-log-club/llm'
import { db, t } from '../db'
import { parseBody, requireUser, type AppEnv } from '../http'
import { enqueueGeneration } from '../jobs'

const MAX_PASTE_CHARS = 200_000

export async function ownItem(userId: string, itemId: string) {
	if (!z.uuid().safeParse(itemId).success) throw new HTTPException(404, { message: 'Not found' })
	const [item] = await db
		.select()
		.from(t.contentItems)
		.where(and(eq(t.contentItems.id, itemId), eq(t.contentItems.userId, userId)))
	if (!item) throw new HTTPException(404, { message: 'Not found' })
	return item
}

const sectionCount = db
	.select({ itemId: t.sections.itemId, n: count().as('section_n') })
	.from(t.sections)
	.groupBy(t.sections.itemId)
	.as('sc')

// Questions written during reviews belong to reviews only, so tests and counts leave them out,
// whichever version of the review prompt wrote them.
const notReviewWritten = notLike(t.questions.promptVersion, `${REVIEW_PROMPT_VERSION.split('-')[0]}-%`)

// Ideas per item, and how many are learned (recalled on 3 separate days).
const ideaCount = db
	.select({
		itemId: t.ideas.itemId,
		n: count().as('idea_n'),
		learned: sql<number>`count(*) filter (where ${t.ideaReviews.mastered})`.as('learned'),
	})
	.from(t.ideas)
	.leftJoin(t.ideaReviews, eq(t.ideaReviews.ideaId, t.ideas.id))
	.groupBy(t.ideas.itemId)
	.as('ic')

const itemQuestionCount = db
	.select({ itemId: t.questions.itemId, n: count().as('question_n') })
	.from(t.questions)
	.where(notReviewWritten)
	.groupBy(t.questions.itemId)
	.as('iqc')

// Per section, not counting linking questions: those are listed separately, since they need several sections.
const questionCount = db
	.select({ sectionId: t.questions.sectionId, n: count().as('n') })
	.from(t.questions)
	.where(and(isNull(t.questions.alsoSectionIds), notReviewWritten))
	.groupBy(t.questions.sectionId)
	.as('qc')

export const ItemPrefs = z.object({
	/** A bucket to add the reading to, at the end. */
	collectionId: z.uuid().nullish(),
})

/** How a reading is added. A page imported from a link in another reading has that reading as its parent. */
export type ItemInput = Partial<z.infer<typeof ItemPrefs>> & { parentId?: string; requestedUrl?: string }

/** The user's readings of these addresses, as address → reading id, by the link asked for or where it led. */
export async function savedReadings(userId: string, urls: string[]): Promise<Map<string, string>> {
	if (!urls.length) return new Map()
	const rows = await db
		.select({ id: t.contentItems.id, requestedUrl: t.contentItems.requestedUrl, sourceUrl: t.contentItems.sourceUrl })
		.from(t.contentItems)
		.where(and(eq(t.contentItems.userId, userId), or(inArray(t.contentItems.requestedUrl, urls), inArray(t.contentItems.sourceUrl, urls))))
	const found = new Map<string, string>()
	for (const r of rows) for (const u of [r.requestedUrl, r.sourceUrl]) if (u && urls.includes(u) && !found.has(u)) found.set(u, r.id)
	return found
}

/**
 * Adds a reading from any source: splits its blocks into sections and puts it at the end of its
 * bucket. It has no questions until they are asked for in Manage test.
 */
export async function createItem(
	userId: string,
	input: { title: string; source: ContentSourceType; sourceUrl?: string; blocks: Block[] } & ItemInput,
) {
	const sections = splitSections(input.blocks, input.title)
	if (!sections.some((s) => s.wordCount > 0)) throw new HTTPException(400, { message: 'No readable text found' })
	const item = await db.transaction(async (tx) => {
		let collectionPosition: number | null = null
		if (input.collectionId) {
			const [owned] = await tx
				.select({ id: t.collections.id })
				.from(t.collections)
				.where(and(eq(t.collections.id, input.collectionId), eq(t.collections.userId, userId)))
				.for('update')
			if (!owned) throw new HTTPException(404, { message: 'That bucket was not found' })
			const [last] = await tx
				.select({ n: sql<number | null>`max(${t.contentItems.collectionPosition})` })
				.from(t.contentItems)
				.where(eq(t.contentItems.collectionId, owned.id))
			collectionPosition = (last?.n ?? -1) + 1
		}
		const [item] = await tx
			.insert(t.contentItems)
			.values({
				userId,
				source: input.source,
				sourceUrl: input.sourceUrl,
				requestedUrl: input.requestedUrl,
				parentId: input.parentId,
				title: input.title,
				collectionId: input.collectionId ?? null,
				collectionPosition,
				status: 'ready',
			})
			.returning()
		await tx.insert(t.sections).values(sections.map((s, position) => ({ itemId: item!.id, position, ...s })))
		return item!
	})
	return item
}

export const library = new Hono<AppEnv>()
	.use(requireUser)
	.get('/', async (c) => {
		const items = await db
			.select({
				id: t.contentItems.id,
				title: t.contentItems.title,
				source: t.contentItems.source,
				status: t.contentItems.status,
				error: t.contentItems.error,
				sectionCount: sql<number>`coalesce(${sectionCount.n}, 0)::int`,
				questionCount: sql<number>`coalesce(${itemQuestionCount.n}, 0)::int`,
				ideaCount: sql<number>`coalesce(${ideaCount.n}, 0)::int`,
				ideasLearned: sql<number>`coalesce(${ideaCount.learned}, 0)::int`,
				createdAt: t.contentItems.createdAt,
				lastOpenedAt: t.contentItems.lastOpenedAt,
				sourceUrl: t.contentItems.sourceUrl,
				collectionId: t.contentItems.collectionId,
				collectionPosition: t.contentItems.collectionPosition,
				parentId: t.contentItems.parentId,
			})
			.from(t.contentItems)
			.leftJoin(sectionCount, eq(sectionCount.itemId, t.contentItems.id))
			.leftJoin(itemQuestionCount, eq(itemQuestionCount.itemId, t.contentItems.id))
			.leftJoin(ideaCount, eq(ideaCount.itemId, t.contentItems.id))
			.where(eq(t.contentItems.userId, c.var.user.id))
			.orderBy(desc(t.contentItems.createdAt))
		const collections = await db
			.select({ id: t.collections.id, name: t.collections.name })
			.from(t.collections)
			.where(eq(t.collections.userId, c.var.user.id))
			.orderBy(asc(t.collections.createdAt))
		return c.json({ items, collections })
	})
	.post('/', async (c) => {
		const { title, text, ...prefs } = await parseBody(
			c,
			ItemPrefs.extend({
				title: z.string().trim().min(1, 'Add a title').max(200),
				text: z.string().trim().min(50, 'Paste at least a paragraph').max(MAX_PASTE_CHARS, 'That is too long for one item. Split it into parts.'),
			}),
		)
		const item = await createItem(c.var.user.id, { title, source: 'paste', blocks: parseMarkdown(text), ...prefs })
		return c.json({ item }, 201)
	})
	.get('/:id', async (c) => {
		const item = await ownItem(c.var.user.id, c.req.param('id'))
		await db.update(t.contentItems).set({ lastOpenedAt: new Date() }).where(eq(t.contentItems.id, item.id))
		const sections = await db
			.select({
				id: t.sections.id,
				position: t.sections.position,
				level: t.sections.level,
				title: t.sections.title,
				blocks: t.sections.blocks,
				wordCount: t.sections.wordCount,
				questionsWanted: t.sections.questionsWanted,
				questionCount: sql<number>`coalesce(${questionCount.n}, 0)::int`,
			})
			.from(t.sections)
			.leftJoin(questionCount, eq(questionCount.sectionId, t.sections.id))
			.where(eq(t.sections.itemId, item.id))
			.orderBy(asc(t.sections.position))
		const [activeSession] = await db
			.select()
			.from(t.studySessions)
			.where(and(eq(t.studySessions.itemId, item.id), isNull(t.studySessions.endedAt)))
			.orderBy(desc(t.studySessions.startedAt))
			.limit(1)
		const links = await db
			.select({ sectionId: t.questions.sectionId, also: t.questions.alsoSectionIds })
			.from(t.questions)
			.where(and(eq(t.questions.itemId, item.id), isNotNull(t.questions.alsoSectionIds)))
		const blocks = sections.flatMap((s) => s.blocks)
		const linked = await savedReadings(c.var.user.id, blockLinks(blocks))
		const children = await db
			.select({ id: t.contentItems.id, title: t.contentItems.title, sourceUrl: t.contentItems.sourceUrl })
			.from(t.contentItems)
			.where(eq(t.contentItems.parentId, item.id))
			.orderBy(asc(t.contentItems.createdAt))
		const [parent] = item.parentId
			? await db.select({ id: t.contentItems.id, title: t.contentItems.title }).from(t.contentItems).where(eq(t.contentItems.id, item.parentId))
			: []
		// Up next is the reading after this one in its bucket.
		const [next] = item.collectionId
			? await db
					.select({ id: t.contentItems.id, title: t.contentItems.title })
					.from(t.contentItems)
					.where(and(eq(t.contentItems.collectionId, item.collectionId), gt(t.contentItems.collectionPosition, item.collectionPosition ?? -1)))
					.orderBy(asc(t.contentItems.collectionPosition))
					.limit(1)
			: []
		return c.json({
			item,
			sections,
			next: next ?? null,
			/** Pages its links point at that are already readings: address → reading id. */
			linked: Object.fromEntries(linked),
			children,
			parent: parent ?? null,
			/** Each linking question, as the sections that must all be picked for it to be asked. */
			links: links.map((l) => ({ sectionIds: [...(l.also ?? []), l.sectionId] })),
			activeSession: activeSession ?? null,
		})
	})
	// A recall test on the sections the user picked. Picking a parent section includes its
	// subsections; the client sends every id it wants. Linking questions are included only when
	// all their sections are picked.
	.post('/:id/test', async (c) => {
		const item = await ownItem(c.var.user.id, c.req.param('id'))
		const { sectionIds, recallId } = await parseBody(
			c,
			z.object({ sectionIds: z.array(z.uuid()).min(1, 'Pick at least one section').max(2000), recallId: z.uuid().optional() }),
		)
		const rows = await db
			.select({ id: t.questions.id, type: t.questions.type, content: t.questions.content, ideaId: t.questions.ideaId })
			.from(t.questions)
			.where(
				and(
					eq(t.questions.itemId, item.id),
					notReviewWritten,
					inArray(t.questions.sectionId, sectionIds),
					or(isNull(t.questions.alsoSectionIds), sql`${t.questions.alsoSectionIds} <@ array[${sql.join(sectionIds.map((id) => sql`${id}`), sql`, `)}]::uuid[]`),
				),
			)
		// What the brain dump missed is asked first.
		const [attempt] = recallId
			? await db
					.select({ results: t.recallAttempts.results })
					.from(t.recallAttempts)
					.where(and(eq(t.recallAttempts.id, recallId), eq(t.recallAttempts.userId, c.var.user.id)))
			: []
		const status = new Map<string, PointStatus>((attempt?.results ?? []).map((r) => [r.ideaId, r.status]))
		const ordered = orderForTest(rows, status)
		return c.json({
			itemTitle: item.title,
			itemStatus: item.status,
			questions: ordered.map((q) => ({ id: q.id, ideaId: q.ideaId, ...toPrompt(q.type, q.content) })),
		})
	})
	// Makes another reading come right after this one: both go in this reading's bucket (a new one,
	// named after it, when it is in none), and the other moves to just after it.
	.put('/:id/next', async (c) => {
		const item = await ownItem(c.var.user.id, c.req.param('id'))
		const { itemId } = await parseBody(c, z.object({ itemId: z.uuid() }))
		const other = await ownItem(c.var.user.id, itemId)
		if (other.id === item.id) throw new HTTPException(400, { message: 'A reading cannot come after itself' })
		await db.transaction(async (tx) => {
			let bucket = item.collectionId
			if (!bucket) {
				const [row] = await tx.insert(t.collections).values({ userId: c.var.user.id, name: item.title.slice(0, 100) }).returning()
				bucket = row!.id
			}
			const members = await tx
				.select({ id: t.contentItems.id })
				.from(t.contentItems)
				.where(eq(t.contentItems.collectionId, bucket))
				.orderBy(asc(t.contentItems.collectionPosition))
				.for('update')
			const ids = members.map((m) => m.id).filter((id) => id !== other.id)
			const at = ids.indexOf(item.id)
			if (at === -1) ids.push(item.id, other.id)
			else ids.splice(at + 1, 0, other.id)
			for (const [position, id] of ids.entries())
				await tx.update(t.contentItems).set({ collectionId: bucket, collectionPosition: position }).where(eq(t.contentItems.id, id))
		})
		return c.json({ ok: true })
	})
	// Manage test: writes questions for the picked sections with the picked settings. Sections that
	// have questions get new ones; their old questions go, with their review history, and so do
	// linking questions that draw on them. Other sections keep theirs.
	.post('/:id/generate', async (c) => {
		const item = await ownItem(c.var.user.id, c.req.param('id'))
		const body = await parseBody(
			c,
			z.object({
				sectionIds: z.array(z.uuid()).min(1, 'Pick at least one section').max(2000),
				intensity: z.enum(QUESTION_INTENSITIES),
				style: z.enum(QUESTION_STYLES),
			}),
		)
		if (item.status === 'processing') throw new HTTPException(409, { message: 'Questions are still being written for this reading' })
		const picked = await db
			.select({ id: t.sections.id })
			.from(t.sections)
			.where(and(eq(t.sections.itemId, item.id), inArray(t.sections.id, body.sectionIds), gt(t.sections.wordCount, 0)))
		if (!picked.length) throw new HTTPException(400, { message: 'Pick sections of this reading that have text' })
		const ids = picked.map((s) => s.id)
		await db.transaction(async (tx) => {
			await tx
				.delete(t.questions)
				.where(and(eq(t.questions.itemId, item.id), or(inArray(t.questions.sectionId, ids), arrayOverlaps(t.questions.alsoSectionIds, ids))))
			await tx.update(t.sections).set({ questionsWanted: true }).where(inArray(t.sections.id, ids))
			await tx
				.update(t.contentItems)
				.set({ status: 'processing', error: null, questionIntensity: body.intensity, questionStyle: body.style })
				.where(eq(t.contentItems.id, item.id))
		})
		await enqueueGeneration(item.id)
		return c.json({ sections: ids.length })
	})
	// Everything that came from the reading goes with it, its vocabulary words too; the rest cascades.
	.delete('/:id', async (c) => {
		const item = await ownItem(c.var.user.id, c.req.param('id'))
		await db.transaction(async (tx) => {
			await tx.delete(t.words).where(eq(t.words.itemId, item.id))
			await tx.delete(t.contentItems).where(eq(t.contentItems.id, item.id))
		})
		return c.json({ ok: true })
	})
