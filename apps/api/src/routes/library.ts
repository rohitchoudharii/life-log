import { orderForTest, parseMarkdown, QUESTION_INTENSITIES, QUESTION_STYLES, splitSections, toPrompt, type PointStatus } from '@peak/core'
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import { REVIEW_PROMPT_VERSION } from '@peak/llm'
import { db, t } from '../db'
import { parseBody, requireUser, type AppEnv } from '../http'
import { enqueueGeneration, rewriteQuestions } from '../jobs'

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

// Questions written during reviews belong to reviews only, so tests and counts leave them out.
const notReviewWritten = ne(t.questions.promptVersion, REVIEW_PROMPT_VERSION)

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
			})
			.from(t.contentItems)
			.leftJoin(sectionCount, eq(sectionCount.itemId, t.contentItems.id))
			.leftJoin(itemQuestionCount, eq(itemQuestionCount.itemId, t.contentItems.id))
			.leftJoin(ideaCount, eq(ideaCount.itemId, t.contentItems.id))
			.where(eq(t.contentItems.userId, c.var.user.id))
			.orderBy(desc(t.contentItems.createdAt))
		return c.json({ items })
	})
	.post('/', async (c) => {
		const { title, text, questionIntensity, questionStyle } = await parseBody(
			c,
			z.object({
				title: z.string().trim().min(1, 'Add a title').max(200),
				text: z.string().trim().min(50, 'Paste at least a paragraph').max(MAX_PASTE_CHARS, 'That is too long for one item. Split it into parts.'),
				questionIntensity: z.enum(QUESTION_INTENSITIES).default('standard'),
				questionStyle: z.enum(QUESTION_STYLES).default('mixed'),
			}),
		)
		const sections = splitSections(parseMarkdown(text), title)
		if (!sections.length) throw new HTTPException(400, { message: 'No readable text found' })
		const item = await db.transaction(async (tx) => {
			const [item] = await tx.insert(t.contentItems).values({ userId: c.var.user.id, source: 'paste', title, questionIntensity, questionStyle })
				.returning()
			await tx.insert(t.sections).values(sections.map((s, position) => ({ itemId: item!.id, position, ...s })))
			return item!
		})
		await enqueueGeneration(item.id)
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
		return c.json({
			item,
			sections,
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
	.post('/:id/rewrite-questions', async (c) => {
		const item = await ownItem(c.var.user.id, c.req.param('id'))
		await rewriteQuestions(item.id)
		return c.json({ ok: true })
	})
	.delete('/:id', async (c) => {
		const item = await ownItem(c.var.user.id, c.req.param('id'))
		await db.delete(t.contentItems).where(eq(t.contentItems.id, item.id))
		return c.json({ ok: true })
	})
