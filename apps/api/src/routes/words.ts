import { gradeResponse, localDay, reviewIdea, startIdea, toPrompt, wordTestFor, type IdeaSchedule } from '@life-log-club/core'
import { defineWord } from '@life-log-club/llm'
import { and, asc, desc, eq, isNull, lte, or, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z, ZodError } from 'zod'
import { db, t } from '../db'
import { parseBody, requireUser, type AppEnv } from '../http'
import { aiFailure, judgeFor, userAi } from '../judge'

/** New words brought into one review, so a long reading does not flood it. */
const NEW_WORDS_PER_REVIEW = 10
/** Words in one review, new and due together. */
const WORDS_PER_REVIEW = 30

type Word = typeof t.words.$inferSelect
const view = (w: Word & { itemTitle?: string | null }) => ({
	id: w.id,
	itemId: w.itemId,
	itemTitle: w.itemTitle ?? null,
	word: w.word,
	form: w.form,
	sentence: w.sentence,
	meaning: w.meaning,
	dueAt: w.schedule ? w.dueAt : null,
	mastered: w.mastered,
	level: w.schedule?.level ?? 0,
})

const content = (w: Word) => ({ word: w.word, form: w.form, sentence: w.sentence, meaning: w.meaning })

/** The test for a word at its level: fill the blank, then say what it means, then use it. */
const testFor = (w: Word) => {
	const type = wordTestFor(w.schedule?.level ?? 0)
	return { id: w.id, ideaId: null, ...toPrompt(type, content(w)) }
}

/**
 * The word as it appears in the sentence: itself, or an inflection of it, so "saturate" finds
 * "saturating". Null when the sentence does not use it.
 */
export function formIn(sentence: string, word: string): string | null {
	const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
	const w = word.toLowerCase()
	const stem = w.replace(/(e|es|s|ed|ing|ly)$/, '')
	// The word itself first, then its stem; either way the whole word in the sentence is taken.
	for (const base of stem.length >= 4 && !w.includes(' ') ? [w, stem] : [w]) {
		const m = sentence.match(new RegExp(`(?<![\\p{L}])${esc(base)}[\\p{L}]{0,4}(?![\\p{L}])`, 'iu'))
		if (m) return m[0]
	}
	return null
}

async function ownWord(userId: string, id: string) {
	if (!z.uuid().safeParse(id).success) throw new HTTPException(404, { message: 'Not found' })
	const [w] = await db.select().from(t.words).where(and(eq(t.words.id, id), eq(t.words.userId, userId)))
	if (!w) throw new HTTPException(404, { message: 'Not found' })
	return w
}

export const words = new Hono<AppEnv>()
	.use(requireUser)
	.get('/words', async (c) => {
		const rows = await db
			.select({ w: t.words, itemTitle: t.contentItems.title })
			.from(t.words)
			.leftJoin(t.contentItems, eq(t.contentItems.id, t.words.itemId))
			.where(eq(t.words.userId, c.var.user.id))
			.orderBy(desc(t.words.createdAt))
		return c.json({ words: rows.map((r) => view({ ...r.w, itemTitle: r.itemTitle })) })
	})
	// Adds a word the learner met, with the sentence they met it in when they have it.
	.post('/words', async (c) => {
		const user = c.var.user
		const input = await parseBody(
			c,
			z.object({
				word: z.string().trim().min(1, 'Type a word').max(60, 'That is longer than a word or term'),
				sentence: z.string().trim().max(600).optional(),
				itemId: z.uuid().optional(),
			}),
		)
		const sentence = input.sentence || null
		const form = sentence ? formIn(sentence, input.word) : input.word
		if (!form) throw new HTTPException(400, { message: 'The sentence must contain the word' })
		const ai = await userAi(user.id, 'define the word')
		let term
		try {
			term = await defineWord(ai.provider, ai.apiKey, ai.model, { form, sentence })
		} catch (err) {
			throw aiFailure(err, 'define the word')
		}
		const [w] = await db
			.insert(t.words)
			.values({ userId: user.id, itemId: input.itemId ?? null, ...term })
			.onConflictDoNothing()
			.returning()
		if (!w) throw new HTTPException(409, { message: `"${term.word}" is already in your vocabulary` })
		return c.json({ word: view(w) })
	})
	.delete('/words/:id', async (c) => {
		const w = await ownWord(c.var.user.id, c.req.param('id'))
		await db.delete(t.words).where(eq(t.words.id, w.id))
		return c.json({ ok: true })
	})
	// Words due for review, oldest first, plus a few new ones.
	.get('/words/due', async (c) => {
		const user = c.var.user
		const due = await db
			.select()
			.from(t.words)
			.where(and(eq(t.words.userId, user.id), sql`${t.words.schedule} is not null`, lte(t.words.dueAt, new Date())))
			.orderBy(asc(t.words.dueAt))
			.limit(WORDS_PER_REVIEW)
		const fresh = await db
			.select()
			.from(t.words)
			.where(and(eq(t.words.userId, user.id), isNull(t.words.schedule)))
			.orderBy(asc(t.words.createdAt))
			.limit(Math.max(0, Math.min(NEW_WORDS_PER_REVIEW, WORDS_PER_REVIEW - due.length)))
		return c.json({ questions: [...due, ...fresh].map(testFor) })
	})
	.get('/words/count', async (c) => {
		const [row] = await db
			.select({ n: sql<number>`count(*)::int` })
			.from(t.words)
			.where(and(eq(t.words.userId, c.var.user.id), or(isNull(t.words.schedule), lte(t.words.dueAt, new Date()))))
		return c.json({ due: row?.n ?? 0 })
	})
	// Grades the word's test and moves its schedule, like an idea's.
	.post('/words/:id/answer', async (c) => {
		const user = c.var.user
		const w = await ownWord(user.id, c.req.param('id'))
		const { response, practice } = await parseBody(c, z.object({ response: z.unknown(), practice: z.boolean().default(false) }))
		const type = wordTestFor(w.schedule?.level ?? 0)
		let grade
		try {
			grade = await gradeResponse(type, content(w), response, judgeFor(user.id))
		} catch (err) {
			if (err instanceof ZodError) throw new HTTPException(400, { message: 'That answer does not fit this question' })
			throw err
		}
		if (practice) return c.json({ correct: grade.correct, rating: grade.rating, reveal: grade.reveal, dueAt: null, practice })
		const now = new Date()
		const day = localDay(now, user.timezone)
		const prev = { schedule: (w.schedule as IdeaSchedule | null) ?? startIdea('recall', day), dueAt: w.schedule ? w.dueAt : now }
		const next = reviewIdea(prev, grade, now, day)
		await db.update(t.words).set({ schedule: next.schedule, dueAt: next.dueAt, mastered: next.schedule.mastered }).where(eq(t.words.id, w.id))
		return c.json({ correct: grade.correct, rating: grade.rating, reveal: grade.reveal, dueAt: next.dueAt, practice })
	})
