import {
	gradeResponse,
	localDay,
	pickQuestion,
	QUESTION_LEVELS,
	reviewIdea,
	sectionText,
	showsChoices,
	startIdea,
	toPrompt,
	type IdeaSchedule,
	type QuestionLevel,
	type QuestionType,
} from '@life-log-club/core'
import { REVIEW_PROMPT_VERSION, writeForIdeas } from '@life-log-club/llm'
import { and, asc, count, countDistinct, desc, eq, gte, inArray, isNotNull, lte, max, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z, ZodError } from 'zod'
import { db, t } from '../db'
import { parseBody, requireUser, type AppEnv, type User } from '../http'
import { judgeFor, userAi } from '../judge'

// Day boundaries are computed here, not in SQL: browsers report legacy zone names such as
// Asia/Calcutta that Node understands but Postgres builds without legacy tzdata reject.

/** Milliseconds the zone is ahead of UTC at `at`. */
function zoneOffset(at: Date, tz: string) {
	const p = Object.fromEntries(
		new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
			.formatToParts(at)
			.map((x) => [x.type, Number(x.value)]),
	) as Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', number>
	return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(at.getTime() / 1000) * 1000
}

/** Midnight today in the user's own timezone, as an instant. */
function startOfLocalDay(tz: string, now = new Date()) {
	const local = new Date(now.getTime() + zoneOffset(now, tz))
	local.setUTCHours(0, 0, 0, 0)
	return new Date(local.getTime() - zoneOffset(local, tz))
}

/** Ideas reviewed since local midnight; retry rounds do not count. The daily cap counts ideas. */
async function reviewedToday(user: User) {
	const [row] = await db
		.select({ n: countDistinct(t.questions.ideaId) })
		.from(t.reviewLog)
		.innerJoin(t.questions, eq(t.questions.id, t.reviewLog.questionId))
		.where(and(eq(t.reviewLog.userId, user.id), eq(t.reviewLog.practice, false), gte(t.reviewLog.reviewedAt, startOfLocalDay(user.timezone))))
	return row?.n ?? 0
}

type Want = { ideaId: string; level: number; lastQuestionId: string | null; exclude?: string[] }

/**
 * One question per idea: an unasked one near the idea's level, else a new one written by the
 * user's AI, else the longest-unasked one. Ideas with no question at all are left out.
 */
async function questionsFor(user: User, wants: Want[]) {
	if (!wants.length) return []
	const ids = wants.map((w) => w.ideaId)
	const lastAsked = db
		.select({ questionId: t.reviewLog.questionId, at: max(t.reviewLog.reviewedAt).as('at') })
		.from(t.reviewLog)
		.where(eq(t.reviewLog.userId, user.id))
		.groupBy(t.reviewLog.questionId)
		.as('la')
	const rows = await db
		.select({
			id: t.questions.id,
			ideaId: t.questions.ideaId,
			type: t.questions.type,
			level: t.questions.level,
			content: t.questions.content,
			lastAskedAt: lastAsked.at,
		})
		.from(t.questions)
		.leftJoin(lastAsked, eq(lastAsked.questionId, t.questions.id))
		.where(and(eq(t.questions.userId, user.id), inArray(t.questions.ideaId, ids)))
	const byId = new Map(rows.map((q) => [q.id, q]))
	const choicesFor = (w: Want) =>
		rows.filter((q) => q.ideaId === w.ideaId && !w.exclude?.includes(q.id)).map((q) => ({ ...q, lastAskedAt: q.lastAskedAt ? new Date(q.lastAskedAt) : null }))
	const picked = new Map<string, string>()
	const stale: Want[] = []
	for (const w of wants) {
		const id = pickQuestion(choicesFor(w), w.level, w.lastQuestionId)
		if (id) picked.set(w.ideaId, id)
		else stale.push(w)
	}

	if (stale.length) {
		const written = await writeFor(user, stale, rows).catch((err) => {
			// No key or a failed call: reviews still work, with questions the learner has seen before.
			console.warn('Could not write review questions:', err instanceof Error ? err.message : err)
			return []
		})
		for (const q of written) {
			byId.set(q.id, { ...q, lastAskedAt: null })
			picked.set(q.ideaId!, q.id)
		}
		for (const w of stale) {
			if (picked.has(w.ideaId)) continue
			const choices = choicesFor(w)
			const id = pickQuestion(choices.length ? choices : rows.filter((q) => q.ideaId === w.ideaId).map((q) => ({ ...q, lastAskedAt: q.lastAskedAt ? new Date(q.lastAskedAt) : null })), w.level, w.lastQuestionId, true)
			if (id) picked.set(w.ideaId, id)
		}
	}
	return wants.flatMap((w) => {
		const q = byId.get(picked.get(w.ideaId) ?? '')
		return q ? [q] : []
	})
}

/** Writes a fresh question for each idea whose questions have all been asked, and stores them. */
async function writeFor(user: User, wants: Want[], existing: { ideaId: string | null; content: unknown }[]) {
	const ideas = await db
		.select({ id: t.ideas.id, text: t.ideas.text, itemId: t.ideas.itemId, sectionId: t.ideas.sectionId, title: t.sections.title, blocks: t.sections.blocks })
		.from(t.ideas)
		.innerJoin(t.sections, eq(t.sections.id, t.ideas.sectionId))
		.where(inArray(t.ideas.id, wants.map((w) => w.ideaId)))
	const ai = await userAi(user.id, 'write new review questions')
	const pairs = wants.flatMap((want) => {
		const idea = ideas.find((i) => i.id === want.ideaId)
		return idea ? [{ want, idea }] : []
	})
	const groups = Array.from({ length: Math.ceil(pairs.length / 8) }, (_, k) => pairs.slice(k * 8, k * 8 + 8))
	const out = await Promise.all(
		groups.map(async (list) => {
			const made = await writeForIdeas(
				ai.provider,
				ai.apiKey,
				ai.model,
				list.map(({ want, idea }) => ({
					idea: idea.text,
					source: sectionText({ title: idea.title, blocks: idea.blocks }),
					level: QUESTION_LEVELS[want.level]!,
					asked: existing.filter((q) => q.ideaId === idea.id).map((q) => (q.content as { prompt: string }).prompt),
				})),
				user.questionStyle,
			)
			const values = made.flatMap((q, k) => {
				const { idea } = list[k]!
				return q ? [{ userId: user.id, itemId: idea.itemId, sectionId: idea.sectionId, ideaId: idea.id, type: q.type, level: q.level, content: q.content, promptVersion: REVIEW_PROMPT_VERSION }] : []
			})
			return values.length ? db.insert(t.questions).values(values).returning() : []
		}),
	)
	return out.flat()
}

const reviewPayload = (q: { id: string; ideaId: string | null; type: QuestionType; content: unknown }, itemTitle?: string) => ({
	id: q.id,
	ideaId: q.ideaId,
	itemTitle,
	...toPrompt(q.type, q.content),
})

/** Topics mixed, then written questions first: seeing options would hint at later answers. */
function arrange<Q extends { type: QuestionType }>(qs: Q[]) {
	for (let i = qs.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1))
		;[qs[i], qs[j]] = [qs[j]!, qs[i]!]
	}
	return qs.sort((a, b) => Number(showsChoices(a.type)) - Number(showsChoices(b.type)))
}

export const study = new Hono<AppEnv>()
	.use(requireUser)
	// Grades an answer and moves its idea's schedule. Retry-round answers (practice) are only logged.
	.post('/answers', async (c) => {
		const user = c.var.user
		const { questionId, response, practice } = await parseBody(
			c,
			z.object({ questionId: z.uuid(), response: z.unknown(), practice: z.boolean().default(false) }),
		)
		const [q] = await db
			.select()
			.from(t.questions)
			.where(and(eq(t.questions.id, questionId), eq(t.questions.userId, user.id)))
		if (!q) throw new HTTPException(404, { message: 'Question not found' })

		let grade
		try {
			grade = await gradeResponse(q.type, q.content, response, judgeFor(user.id))
		} catch (err) {
			if (err instanceof ZodError) throw new HTTPException(400, { message: 'That answer does not fit this question' })
			throw err
		}
		const now = new Date()
		const day = localDay(now, user.timezone)
		const ideaId = q.ideaId
		const dueAt = await db.transaction(async (tx) => {
			await tx.insert(t.reviewLog).values({
				userId: user.id,
				questionId,
				rating: grade.rating,
				correct: grade.correct,
				response,
				practice,
				feedback: typeof grade.reveal.feedback === 'string' ? grade.reveal.feedback : null,
				reviewedAt: now,
			})
			if (practice || !ideaId) return null
			// Answers on one idea arrive together at the end of a test; the row lock applies them one at a time.
			await tx
				.insert(t.ideaReviews)
				.values({ ideaId, userId: user.id, schedule: startIdea(q.level, day), dueAt: now, lastReviewedAt: now })
				.onConflictDoNothing()
			const [row] = await tx.select().from(t.ideaReviews).where(eq(t.ideaReviews.ideaId, ideaId)).for('update')
			const next = reviewIdea({ schedule: row!.schedule, dueAt: row!.dueAt }, grade, now, day)
			await tx
				.update(t.ideaReviews)
				.set({ schedule: next.schedule, mastered: next.schedule.mastered, dueAt: next.dueAt, lastReviewedAt: now, lastQuestionId: questionId })
				.where(eq(t.ideaReviews.ideaId, ideaId))
			return next.dueAt
		})
		return c.json({ correct: grade.correct, rating: grade.rating, reveal: grade.reveal, dueAt, practice })
	})
	// One question per due idea, oldest first, limited so the ideas reviewed today stay under the cap.
	.get('/reviews/due', async (c) => {
		const user = c.var.user
		const room = Math.max(0, user.dailyReviewCap - (await reviewedToday(user)))
		const due = room
			? await db
					.select({ ideaId: t.ideaReviews.ideaId, schedule: t.ideaReviews.schedule, lastQuestionId: t.ideaReviews.lastQuestionId, itemTitle: t.contentItems.title })
					.from(t.ideaReviews)
					.innerJoin(t.ideas, eq(t.ideas.id, t.ideaReviews.ideaId))
					.innerJoin(t.contentItems, eq(t.contentItems.id, t.ideas.itemId))
					.where(and(eq(t.ideaReviews.userId, user.id), lte(t.ideaReviews.dueAt, new Date())))
					.orderBy(asc(t.ideaReviews.dueAt))
					.limit(room)
			: []
		const questions = await questionsFor(
			user,
			due.map((d) => ({ ideaId: d.ideaId, level: d.schedule.level, lastQuestionId: d.lastQuestionId })),
		)
		const title = new Map(due.map((d) => [d.ideaId, d.itemTitle]))
		return c.json({ questions: arrange(questions).map((q) => reviewPayload(q, title.get(q.ideaId!))) })
	})
	// The retry round: a different question on each idea just missed. It does not move schedules.
	.post('/reviews/retry', async (c) => {
		const user = c.var.user
		const { ideaIds, exclude } = await parseBody(
			c,
			z.object({ ideaIds: z.array(z.uuid()).min(1).max(100), exclude: z.array(z.uuid()).max(2000).default([]) }),
		)
		const rows = await db
			.select({ ideaId: t.ideas.id, schedule: t.ideaReviews.schedule, itemTitle: t.contentItems.title })
			.from(t.ideas)
			.innerJoin(t.contentItems, eq(t.contentItems.id, t.ideas.itemId))
			.leftJoin(t.ideaReviews, eq(t.ideaReviews.ideaId, t.ideas.id))
			.where(and(eq(t.contentItems.userId, user.id), inArray(t.ideas.id, ideaIds)))
		const questions = await questionsFor(
			user,
			rows.map((r) => ({ ideaId: r.ideaId, level: (r.schedule as IdeaSchedule | null)?.level ?? 0, lastQuestionId: null, exclude })),
		)
		const title = new Map(rows.map((r) => [r.ideaId, r.itemTitle]))
		return c.json({ questions: arrange(questions).map((q) => reviewPayload(q, title.get(q.ideaId!))) })
	})
	.get('/today', async (c) => {
		const user = c.var.user
		const tz = user.timezone
		const [due] = await db
			.select({ n: count() })
			.from(t.ideaReviews)
			.where(and(eq(t.ideaReviews.userId, user.id), lte(t.ideaReviews.dueAt, new Date())))
		const done = await reviewedToday(user)
		// Local days with at least one review, for the streak.
		// Every real UTC offset is a multiple of 15 minutes, so 15-minute buckets map to local days exactly.
		const buckets = await db.execute<{ at: string }>(sql`
			select distinct date_bin('15 minutes', ${t.reviewLog.reviewedAt}, timestamptz '2000-01-01') as at
			from ${t.reviewLog}
			where ${t.reviewLog.userId} = ${user.id} and ${t.reviewLog.reviewedAt} >= now() - interval '60 days'`)
		const active = new Set(buckets.map((b) => localDay(new Date(b.at), tz)))
		const daysAgo = (n: number) => localDay(new Date(Date.now() - n * 86_400_000), tz)
		// A streak survives until the end of today, so start counting from yesterday if today is empty.
		let streak = 0
		for (let i = active.has(daysAgo(0)) ? 0 : 1; active.has(daysAgo(i)); i++) streak++

		// Readings the user has opened, most recent first.
		const ongoing = await db
			.select({ id: t.contentItems.id, title: t.contentItems.title })
			.from(t.contentItems)
			.where(and(eq(t.contentItems.userId, user.id), isNotNull(t.contentItems.lastOpenedAt)))
			.orderBy(desc(t.contentItems.lastOpenedAt))
			.limit(5)
		return c.json({
			due: Math.min(due?.n ?? 0, Math.max(0, user.dailyReviewCap - done)),
			reviewedToday: done,
			dailyReviewCap: user.dailyReviewCap,
			streak,
			ongoing,
		})
	})
