import { sectionText } from '@peak/core'
import { extractIdeas, gradeRecall } from '@peak/llm'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import { db, t } from '../db'
import { parseBody, requireUser, type AppEnv } from '../http'
import { aiFailure, userAi } from '../judge'
import { ownItem } from './library'

/** The key ideas of the given sections in reading order, written first for sections that have none yet. */
async function ideasFor(userId: string, itemId: string, sectionIds: string[], write = true) {
	const sections = await db
		.select()
		.from(t.sections)
		.where(and(eq(t.sections.itemId, itemId), inArray(t.sections.id, sectionIds)))
		.orderBy(asc(t.sections.position))
	const load = () =>
		db
			.select({ id: t.ideas.id, sectionId: t.ideas.sectionId, text: t.ideas.text, position: t.ideas.position })
			.from(t.ideas)
			.where(inArray(t.ideas.sectionId, sections.map((s) => s.id)))
	let rows = await load()
	const missing = sections.filter((s) => s.wordCount > 0 && !rows.some((r) => r.sectionId === s.id))
	if (write && missing.length) {
		const ai = await userAi(userId, 'check your brain dump')
		let lists: string[][]
		try {
			lists = await extractIdeas(ai.provider, ai.apiKey, ai.model, missing.map((s) => ({ title: s.title, text: sectionText(s) })))
		} catch (err) {
			throw aiFailure(err, 'list the key ideas')
		}
		const values = missing.flatMap((s, i) => (lists[i] ?? []).map((text, position) => ({ itemId, sectionId: s.id, position, text })))
		if (values.length) await db.insert(t.ideas).values(values)
		rows = await load()
	}
	const order = new Map(sections.map((s, i) => [s.id, i]))
	return rows
		.map((r) => ({ ...r, section: sections[order.get(r.sectionId)!]!.title, sectionOrder: order.get(r.sectionId)! }))
		.sort((a, b) => a.sectionOrder - b.sectionOrder || a.position - b.position)
}

type Attempt = typeof t.recallAttempts.$inferSelect

/** Grades an attempt and stores the result. A grading failure is returned, not thrown, so the test can go on. */
async function grade(userId: string, attempt: Attempt) {
	let gradeError: string | null = null
	let ideas: Awaited<ReturnType<typeof ideasFor>>
	try {
		ideas = await ideasFor(userId, attempt.itemId, attempt.sectionIds)
	} catch (err) {
		if (!(err instanceof HTTPException)) throw err
		gradeError = err.message
		ideas = await ideasFor(userId, attempt.itemId, attempt.sectionIds, false)
	}
	if (ideas.length && !gradeError) {
		try {
			const ai = await userAi(userId, 'check your brain dump')
			const verdict = await gradeRecall(ai.provider, ai.apiKey, ai.model, { ideas: ideas.map((i) => i.text), text: attempt.text }).catch((err) => {
				throw aiFailure(err, 'check your brain dump')
			})
			const results = ideas.map((idea, i) => ({ ideaId: idea.id, status: verdict.ideas[i]! }))
			await db.update(t.recallAttempts).set({ results, feedback: verdict.feedback }).where(eq(t.recallAttempts.id, attempt.id))
			attempt = { ...attempt, results, feedback: verdict.feedback }
		} catch (err) {
			if (!(err instanceof HTTPException)) throw err
			gradeError = err.message
		}
	}
	const status = new Map((attempt.results ?? []).map((r) => [r.ideaId, r.status]))
	return {
		id: attempt.id,
		text: attempt.text,
		feedback: attempt.feedback,
		gradeError,
		ideas: ideas.map((i) => ({ id: i.id, text: i.text, section: i.section, status: status.get(i.id) ?? null })),
	}
}

/** The brain dump: before every test, the user writes everything they remember from the picked sections. */
export const recall = new Hono<AppEnv>()
	.use(requireUser)
	.post('/items/:id/recall', async (c) => {
		const user = c.var.user
		const item = await ownItem(user.id, c.req.param('id'))
		const { sectionIds, text } = await parseBody(
			c,
			z.object({
				sectionIds: z.array(z.uuid()).min(1, 'Pick at least one section').max(2000),
				text: z.string().trim().min(1, 'Write down what you remember first').max(20_000, 'That is longer than a brain dump needs'),
			}),
		)
		const [attempt] = await db.insert(t.recallAttempts).values({ userId: user.id, itemId: item.id, sectionIds, text }).returning()
		return c.json({ recall: await grade(user.id, attempt!) })
	})
	.post('/recall/:id/grade', async (c) => {
		const user = c.var.user
		const id = c.req.param('id')
		if (!z.uuid().safeParse(id).success) throw new HTTPException(404, { message: 'Not found' })
		const [attempt] = await db.select().from(t.recallAttempts).where(and(eq(t.recallAttempts.id, id), eq(t.recallAttempts.userId, user.id)))
		if (!attempt) throw new HTTPException(404, { message: 'Not found' })
		return c.json({ recall: await grade(user.id, attempt) })
	})
