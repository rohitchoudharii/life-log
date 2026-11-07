import { localDay, sectionText, startIdea } from '@life-log-club/core'
import { EXPLAIN_KINDS, EXPLAIN_LEVELS, explainPassage, teachTurn, type TeachMessage } from '@life-log-club/llm'
import { and, asc, desc, eq, gt } from 'drizzle-orm'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import { db, t } from '../db'
import type { FeynmanDetail } from '../db/schema'
import { parseBody, requireUser, type AppEnv, type User } from '../http'
import { aiFailure, userAi } from '../judge'
import { ownItem } from './library'

/** An idea taught back with gaps comes up for review this soon, like an idea missed in a test. */
const GAP_REVIEW_MS = 10 * 60_000

type Note = typeof t.notes.$inferSelect
const view = (n: Note) => ({ id: n.id, itemId: n.itemId, sectionId: n.sectionId, ideaId: n.ideaId, kind: n.kind, passage: n.passage, detail: n.detail, createdAt: n.createdAt })

const notFound = () => new HTTPException(404, { message: 'Not found' })
const uuidParam = (id: string) => {
	if (!z.uuid().safeParse(id).success) throw notFound()
	return id
}

async function ownNote(userId: string, id: string) {
	const [note] = await db
		.select()
		.from(t.notes)
		.where(and(eq(t.notes.id, uuidParam(id)), eq(t.notes.userId, userId)))
	if (!note) throw notFound()
	return note
}

const message = z.object({ text: z.string().trim().min(1, 'Write your explanation first').max(6000, 'Keep it shorter: teach the idea, not the whole text') })

/** Runs the student's next turn and stores it. Gaps found at the end bring the idea back for review soon. */
async function nextTurn(user: User, note: Note, source: string) {
	const detail = note.detail as FeynmanDetail
	const ai = await userAi(user.id, 'play the student')
	let turn
	try {
		turn = await teachTurn(ai.provider, ai.apiKey, ai.model, { idea: detail.idea, source, messages: detail.messages })
	} catch (err) {
		throw aiFailure(err, 'reply as the student')
	}
	const next: FeynmanDetail =
		turn.kind === 'question'
			? { ...detail, messages: [...detail.messages, { role: 'student', text: turn.text }] }
			: { ...detail, result: { gaps: turn.gaps, strengths: turn.strengths, summary: turn.summary } }
	const now = new Date()
	const [saved] = await db.transaction(async (tx) => {
		if (turn.kind === 'done' && turn.gaps.length && note.ideaId) {
			const soon = new Date(now.getTime() + GAP_REVIEW_MS)
			await tx
				.insert(t.ideaReviews)
				.values({ ideaId: note.ideaId, userId: user.id, schedule: startIdea('explain', localDay(now, user.timezone)), dueAt: soon, lastReviewedAt: now })
				.onConflictDoNothing()
			// Only ever sooner: a gap never pushes a review that was already due further out.
			await tx
				.update(t.ideaReviews)
				.set({ dueAt: soon })
				.where(and(eq(t.ideaReviews.ideaId, note.ideaId), gt(t.ideaReviews.dueAt, soon)))
		}
		return tx.update(t.notes).set({ detail: next, updatedAt: now }).where(eq(t.notes.id, note.id)).returning()
	})
	return saved!
}

async function sourceOf(sectionId: string) {
	const [section] = await db.select().from(t.sections).where(eq(t.sections.id, sectionId))
	return section ? sectionText(section) : ''
}

export const notes = new Hono<AppEnv>()
	.use(requireUser)
	.get('/items/:id/notes', async (c) => {
		const item = await ownItem(c.var.user.id, c.req.param('id'))
		const rows = await db.select().from(t.notes).where(eq(t.notes.itemId, item.id)).orderBy(desc(t.notes.createdAt))
		return c.json({ notes: rows.map(view) })
	})
	// Explains a passage the learner picked, grounded in its section, and keeps the explanation.
	.post('/items/:id/explain', async (c) => {
		const user = c.var.user
		const item = await ownItem(user.id, c.req.param('id'))
		const input = await parseBody(
			c,
			z.object({
				sectionId: z.uuid(),
				passage: z.string().trim().min(1, 'Pick some text to explain').max(4000, 'Pick a shorter passage'),
				// Left out, the level comes from the user's settings.
				level: z.enum(EXPLAIN_LEVELS).optional(),
				kind: z.enum(EXPLAIN_KINDS).default('explain'),
			}),
		)
		const level = input.level ?? user.explainLevel
		const { kind } = input
		const [section] = await db
			.select()
			.from(t.sections)
			.where(and(eq(t.sections.id, input.sectionId), eq(t.sections.itemId, item.id)))
		if (!section) throw notFound()
		const ai = await userAi(user.id, 'explain this')
		let out
		try {
			out = await explainPassage(ai.provider, ai.apiKey, ai.model, { section: sectionText(section), passage: input.passage, level, kind })
		} catch (err) {
			throw aiFailure(err, 'explain this')
		}
		const [note] = await db
			.insert(t.notes)
			.values({ userId: user.id, itemId: item.id, sectionId: section.id, kind: 'explanation', passage: input.passage, detail: { level, kind, ...out } })
			.returning()
		return c.json({ note: view(note!) })
	})
	.delete('/notes/:id', async (c) => {
		const note = await ownNote(c.var.user.id, c.req.param('id'))
		await db.delete(t.notes).where(eq(t.notes.id, note.id))
		return c.json({ ok: true })
	})
	.get('/notes/:id', async (c) => c.json({ note: view(await ownNote(c.var.user.id, c.req.param('id'))) }))
	// The item's key ideas in reading order, to pick one to teach back.
	.get('/items/:id/ideas', async (c) => {
		const item = await ownItem(c.var.user.id, c.req.param('id'))
		const rows = await db
			.select({ id: t.ideas.id, text: t.ideas.text, section: t.sections.title })
			.from(t.ideas)
			.innerJoin(t.sections, eq(t.sections.id, t.ideas.sectionId))
			.where(eq(t.ideas.itemId, item.id))
			.orderBy(asc(t.sections.position), asc(t.ideas.position))
		return c.json({ ideas: rows })
	})
	// Starts a Feynman session: the learner's first explanation, and the student's first question.
	.post('/ideas/:id/teach', async (c) => {
		const user = c.var.user
		const { text } = await parseBody(c, message)
		const [idea] = await db
			.select({ id: t.ideas.id, text: t.ideas.text, itemId: t.ideas.itemId, sectionId: t.ideas.sectionId })
			.from(t.ideas)
			.innerJoin(t.contentItems, eq(t.contentItems.id, t.ideas.itemId))
			.where(and(eq(t.ideas.id, uuidParam(c.req.param('id'))), eq(t.contentItems.userId, user.id)))
		if (!idea) throw notFound()
		const messages: TeachMessage[] = [{ role: 'learner', text }]
		const [note] = await db
			.insert(t.notes)
			.values({ userId: user.id, itemId: idea.itemId, sectionId: idea.sectionId, ideaId: idea.id, kind: 'feynman', detail: { idea: idea.text, messages, result: null } })
			.returning()
		try {
			return c.json({ note: view(await nextTurn(user, note!, await sourceOf(idea.sectionId))) })
		} catch (err) {
			// No session without a first question; the learner sends their explanation again.
			await db.delete(t.notes).where(eq(t.notes.id, note!.id))
			throw err
		}
	})
	// The learner's answer to the student's question. Nothing is stored until the student replies, so a failed turn is simply sent again.
	.post('/notes/:id/teach', async (c) => {
		const user = c.var.user
		const note = await ownNote(user.id, c.req.param('id'))
		const detail = note.detail as FeynmanDetail
		if (note.kind !== 'feynman' || detail.result) throw new HTTPException(409, { message: 'This session is over' })
		const { text } = await parseBody(c, message)
		const answered = { ...note, detail: { ...detail, messages: [...detail.messages, { role: 'learner' as const, text }] } }
		return c.json({ note: view(await nextTurn(user, answered, await sourceOf(note.sectionId))) })
	})
