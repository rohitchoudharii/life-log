import { defaultScheduler, gradeResponse, toPrompt } from '@peak/core'
import { and, asc, count, desc, eq, gte, isNotNull, lte, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z, ZodError } from 'zod'
import { db, t } from '../db'
import { parseBody, requireUser, type AppEnv, type User } from '../http'
import { judgeFor } from '../judge'

// Day boundaries are computed here, not in SQL: browsers report legacy zone names such as
// Asia/Calcutta that Node understands but Postgres builds without legacy tzdata reject.
const localDay = (at: Date, tz: string) => at.toLocaleDateString('en-CA', { timeZone: tz })

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

async function reviewedToday(user: User) {
	const [row] = await db
		.select({ n: count() })
		.from(t.reviewLog)
		.where(and(eq(t.reviewLog.userId, user.id), gte(t.reviewLog.reviewedAt, startOfLocalDay(user.timezone))))
	return row?.n ?? 0
}

export const study = new Hono<AppEnv>()
	.use(requireUser)
	.post('/answers', async (c) => {
		const user = c.var.user
		const { questionId, response } = await parseBody(c, z.object({ questionId: z.uuid(), response: z.unknown() }))
		const [q] = await db
			.select({ question: t.questions, review: t.reviews })
			.from(t.questions)
			.leftJoin(t.reviews, eq(t.reviews.questionId, t.questions.id))
			.where(and(eq(t.questions.id, questionId), eq(t.questions.userId, user.id)))
		if (!q) throw new HTTPException(404, { message: 'Question not found' })

		let grade
		try {
			grade = await gradeResponse(q.question.type, q.question.content, response, judgeFor(user.id))
		} catch (err) {
			if (err instanceof ZodError) throw new HTTPException(400, { message: 'That answer does not fit this question' })
			throw err
		}
		const now = new Date()
		const { state, dueAt } = defaultScheduler.next(q.review?.state ?? defaultScheduler.initial(), grade.rating, now)
		await db.transaction(async (tx) => {
			await tx
				.insert(t.reviews)
				.values({ questionId, userId: user.id, state, dueAt, lastReviewedAt: now })
				.onConflictDoUpdate({ target: t.reviews.questionId, set: { state, dueAt, lastReviewedAt: now } })
			await tx.insert(t.reviewLog).values({
				userId: user.id,
				questionId,
				rating: grade.rating,
				correct: grade.correct,
				response,
				feedback: typeof grade.reveal.feedback === 'string' ? grade.reveal.feedback : null,
				reviewedAt: now,
			})
		})
		return c.json({ correct: grade.correct, rating: grade.rating, reveal: grade.reveal, dueAt })
	})
	// Due reviews, oldest first, limited so the daily total stays under the user's cap.
	.get('/reviews/due', async (c) => {
		const user = c.var.user
		const room = Math.max(0, user.dailyReviewCap - (await reviewedToday(user)))
		const rows = room
			? await db
					.select({ id: t.questions.id, type: t.questions.type, content: t.questions.content, itemTitle: t.contentItems.title })
					.from(t.reviews)
					.innerJoin(t.questions, eq(t.questions.id, t.reviews.questionId))
					.innerJoin(t.contentItems, eq(t.contentItems.id, t.questions.itemId))
					.where(and(eq(t.reviews.userId, user.id), lte(t.reviews.dueAt, new Date())))
					.orderBy(asc(t.reviews.dueAt))
					.limit(room)
			: []
		// Shuffle so topics interleave instead of arriving in blocks from one source.
		for (let i = rows.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1))
			;[rows[i], rows[j]] = [rows[j]!, rows[i]!]
		}
		return c.json({ questions: rows.map((q) => ({ id: q.id, itemTitle: q.itemTitle, ...toPrompt(q.type, q.content) })) })
	})
	.get('/today', async (c) => {
		const user = c.var.user
		const tz = user.timezone
		const [due] = await db
			.select({ n: count() })
			.from(t.reviews)
			.where(and(eq(t.reviews.userId, user.id), lte(t.reviews.dueAt, new Date())))
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
