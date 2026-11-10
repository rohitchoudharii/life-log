import { randomUUID } from 'node:crypto'
import { defaultScheduler, type PointStatus, type SchedulerState } from '@life-log-club/domain'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { asUser, ownerDb, ownerPool, pool } from '../db/client'
import { prepareDatabase } from '../db/prepare'
import { cards, readings, recallAttempts, reviewLog, users } from '../db/schema'
import { mindSummary, progressSummary } from './progress'

beforeAll(prepareDatabase)
afterAll(() => Promise.all([pool.end(), ownerPool.end()]))

const DAY = 86_400_000
// A Wednesday, so answers on the Sundays before it test that weeks start on Monday.
const now = new Date('2026-11-11T12:00:00Z')
const ago = (days: number) => new Date(now.getTime() - days * DAY)
const at = (iso: string) => new Date(iso)

/** A card past the steps whose FSRS memory lasts `stability` days, last answered `daysAgo`. */
const graduated = (stability: number, daysAgo: number): SchedulerState => ({
	step: null,
	relearning: null,
	reps: 5,
	lapses: 0,
	memory: { stability, difficulty: 5 },
	lastReviewAt: ago(daysAgo).toISOString(),
})
const learning = (daysAgo: number): SchedulerState => ({ step: 1, relearning: null, reps: 1, lapses: 0, memory: { stability: 2, difficulty: 5 }, lastReviewAt: ago(daysAgo).toISOString() })

it('counts ideas by status, recall at review by week, recall by gap and brain dump coverage, each as defined', async () => {
	const [user] = await ownerDb.insert(users).values({ email: `progress-${randomUUID()}@example.com`, name: 'P' }).returning()
	const userId = user!.id
	const readingId = randomUUID()
	await ownerDb.insert(readings).values({ id: readingId, userId, title: 'Peak', source: 'url', status: 'ready' })
	const ids = { known: randomUUID(), fading: randomUUID(), learning: randomUUID(), fresh: randomUUID(), removed: randomUUID(), dueNow: randomUUID() }
	const card = (id: string, state: SchedulerState, dueAt: Date, extra: Partial<typeof cards.$inferInsert> = {}) => ({
		id,
		userId,
		kind: 'idea' as const,
		prompt: `Card ${id.slice(0, 4)}`,
		answer: 'An answer.',
		state,
		dueAt,
		startedAt: ago(60),
		...extra,
	})
	await ownerDb.insert(cards).values([
		// Recall now is about 99%: known. Not due for 10 days.
		card(ids.known, graduated(100, 1), new Date(now.getTime() + 10 * DAY), { readingId }),
		// Recall now is about 70%: fading. Not due until tomorrow.
		card(ids.fading, graduated(2, 20), new Date(now.getTime() + DAY), { kind: 'lesson' }),
		card(ids.learning, learning(1), new Date(now.getTime() + DAY), { readingId }),
		card(ids.fresh, defaultScheduler.initial(), now, { readingId, startedAt: null }),
		card(ids.removed, graduated(100, 1), new Date(now.getTime() + DAY), { readingId, deletedAt: ago(1) }),
		// Graduated and fading too, but already due, so Review has it, not Fading.
		card(ids.dueNow, graduated(2, 30), ago(1)),
	])

	const answer = (cardId: string, reviewedAt: Date, right: boolean | null, prev: SchedulerState | null, extra: Partial<typeof reviewLog.$inferInsert> = {}) => ({
		userId,
		cardId,
		answerId: randomUUID(),
		mode: 'review' as const,
		rating: right === false ? ('again' as const) : ('good' as const),
		correct: right,
		prev: prev && { state: prev, level: 1, dueAt: reviewedAt.toISOString() },
		reviewedAt,
		nextDueAt: reviewedAt,
		...extra,
	})
	/** The state before an answer at `when`, last answered `gapDays` before it. */
	const before = (when: Date, gapDays: number, step: number | null = null): SchedulerState => ({
		...graduated(30, 0),
		step,
		lastReviewAt: new Date(when.getTime() - gapDays * DAY).toISOString(),
	})
	const A = at('2026-11-01T10:00:00Z') // Sunday: the week of 26 Oct
	const C = at('2026-11-08T10:00:00Z') // Sunday: the week of 2 Nov
	const H = at('2026-11-07T10:00:00Z') // Saturday: the week of 2 Nov
	const E = at('2026-10-02T10:00:00Z') // 40 days ago: in the 84 days, not the last 30
	await ownerDb.insert(reviewLog).values([
		answer(ids.known, A, true, before(A, 30)),
		// A second answer the same day doesn't count; only the first one does.
		answer(ids.known, new Date(A.getTime() + 60 * 60 * 1000), false, before(A, 0.04)),
		answer(ids.fading, C, false, before(C, 5)),
		// Counted as right by the member: left out.
		answer(ids.fading, ago(2), true, before(ago(2), 1), { overriddenAt: ago(2) }),
		// A rating with no verdict kept: Forgot is wrong.
		answer(ids.known, H, null, before(H, 6), { rating: 'again' }),
		answer(ids.known, E, true, before(E, 60)),
		// Past the 84 days.
		answer(ids.known, ago(100), true, before(ago(100), 30)),
		// In the steps: counts for recall by gap, not for recall at review.
		answer(ids.learning, ago(1), true, before(ago(1), 1, 1)),
		// Practice (a retry round, or a reported answer) and recall answers never count.
		answer(ids.fading, ago(5), true, before(ago(5), 3), { mode: 'practice' }),
		answer(ids.fading, ago(6), true, before(ago(6), 3), { mode: 'recall' }),
		// From before the state was kept with each answer: no gap, and not known to be graduated.
		answer(ids.known, ago(9), true, null),
	])

	const attempt = (submittedAt: Date | null, statuses: PointStatus[] | null) => ({
		id: randomUUID(),
		userId,
		readingId,
		sectionIds: [],
		status: statuses ? ('graded' as const) : ('open' as const),
		results: statuses?.map((status) => ({ cardId: ids.known, status })) ?? null,
		submittedAt,
	})
	const graded = attempt(ago(5), ['covered', 'covered', 'vague', 'missing'])
	await ownerDb.insert(recallAttempts).values([graded, attempt(null, null), attempt(ago(100), ['covered'])])

	const progress = await asUser(userId, (tx) => progressSummary(tx, userId, 84, now))
	expect(progress.ideas).toEqual({
		total: { new: 1, learning: 1, known: 1, fading: 2 },
		readings: [{ readingId, title: 'Peak', counts: { new: 1, learning: 1, known: 1, fading: 0 } }],
	})
	expect(progress.recallAtReview).toEqual({
		right: 2,
		total: 4,
		target: 0.9,
		weeks: [
			{ week: at('2026-09-28T00:00:00Z'), right: 1, total: 1 },
			{ week: at('2026-10-26T00:00:00Z'), right: 1, total: 1 },
			{ week: at('2026-11-02T00:00:00Z'), right: 0, total: 2 },
		],
	})
	expect(progress.recallByGap).toEqual([
		{ gap: '1d', right: 1, total: 1 },
		{ gap: '2d', right: 0, total: 0 },
		{ gap: '3d', right: 0, total: 0 },
		{ gap: 'month', right: 0, total: 2 },
		{ gap: 'quarter', right: 2, total: 2 },
		{ gap: 'longer', right: 0, total: 0 },
	])
	expect(progress.dumps).toEqual([{ attemptId: graded.id, at: graded.submittedAt, reading: 'Peak', covered: 2, total: 4 }])

	const mind = await asUser(userId, (tx) => mindSummary(tx, now))
	expect(mind.fading.map((f) => f.cardId)).toEqual([ids.fading, ids.known])
	expect(mind.fading[0]!.recall).toBeLessThan(0.85)
	expect(mind.fading[1]!.recall).toBeGreaterThan(0.85)
	expect(mind.fading[0]!.source).toBeNull()
	expect(mind.fading[1]!.source).toEqual({ reading: 'Peak', section: null })
	// The last 30 days: the answers on 1, 7 and 8 November.
	expect(mind.recall30d).toEqual({ right: 1, total: 3 })

	// Another member sees none of it.
	const [other] = await ownerDb.insert(users).values({ email: `progress-${randomUUID()}@example.com`, name: 'Q' }).returning()
	const theirs = await asUser(other!.id, (tx) => progressSummary(tx, other!.id, 84, now))
	expect(theirs.ideas.total).toEqual({ new: 0, learning: 0, known: 0, fading: 0 })
	expect(theirs.recallAtReview.total).toBe(0)
	expect(theirs.dumps).toEqual([])
})

it('calibration counts recall and review answers given with a confidence, and Sure but wrong in this month', async () => {
	const [user] = await ownerDb.insert(users).values({ email: `calibration-${randomUUID()}@example.com`, name: 'C' }).returning()
	const userId = user!.id
	const cardId = randomUUID()
	await ownerDb.insert(cards).values({ id: cardId, userId, kind: 'idea', prompt: 'Why?', answer: 'Because.', state: defaultScheduler.initial(), startedAt: ago(60) })
	const answer = (daysAgo: number, confidence: 'sure' | 'think_so' | 'guessing' | null, correct: boolean | null, extra: Partial<typeof reviewLog.$inferInsert> = {}) => ({
		userId,
		cardId,
		answerId: randomUUID(),
		mode: 'review' as const,
		rating: correct === false ? ('again' as const) : ('good' as const),
		correct,
		confidence,
		reviewedAt: ago(daysAgo),
		nextDueAt: ago(daysAgo),
		...extra,
	})
	await ownerDb.insert(reviewLog).values([
		answer(1, 'sure', true),
		answer(2, 'sure', false),
		// 22 October: counted, but not in this month.
		answer(20, 'sure', false, { mode: 'recall' }),
		// No verdict kept: Forgot is wrong.
		answer(5, 'sure', null, { rating: 'again' }),
		answer(3, 'think_so', true),
		answer(4, 'guessing', false),
		// Left out: practice, no confidence, and past the 84 days.
		answer(1, 'sure', false, { mode: 'practice' }),
		answer(1, null, true),
		answer(100, 'sure', true),
	])
	const progress = await asUser(userId, (tx) => progressSummary(tx, userId, 84, now))
	expect(progress.calibration).toEqual({
		sure: { right: 1, total: 4 },
		think_so: { right: 1, total: 1 },
		guessing: { right: 0, total: 1 },
		sureWrongThisMonth: 2,
	})
})

it('scheduler fit groups answers by predicted recall in tenths, against how many were right; honesty and reading count as defined', async () => {
	const [user] = await ownerDb.insert(users).values({ email: `fit-${randomUUID()}@example.com`, name: 'F' }).returning()
	const userId = user!.id
	const cardId = randomUUID()
	await ownerDb.insert(cards).values({ id: cardId, userId, kind: 'idea', prompt: 'Why?', answer: 'Because.', state: defaultScheduler.initial(), dueAt: now, startedAt: ago(60) })
	type Row = { predicted: number | null; correct: boolean; mode?: 'recall' | 'review' | 'practice'; daysAgo?: number; gradedBy?: 'ai' | 'code' | 'self'; overridden?: boolean }
	const rows: Row[] = [
		// 90 to 100%: four answers, three right.
		{ predicted: 0.95, correct: true },
		{ predicted: 0.91, correct: true },
		{ predicted: 1, correct: true },
		{ predicted: 0.9, correct: false, gradedBy: 'ai', overridden: false },
		// 60 to 70%: two answers, one right, one of them counted as right by the member.
		{ predicted: 0.62, correct: false, gradedBy: 'ai' },
		{ predicted: 0.68, correct: true, gradedBy: 'ai', overridden: true },
		// 0 to 10%: a recall answer.
		{ predicted: 0.05, correct: false, mode: 'recall', gradedBy: 'code' },
		// Left out: practice, no prediction, and before the period.
		{ predicted: 0.5, correct: true, mode: 'practice', gradedBy: 'ai', overridden: true },
		{ predicted: null, correct: true },
		{ predicted: 0.5, correct: true, daysAgo: 100 },
	]
	await ownerDb.insert(reviewLog).values(
		rows.map((r) => ({
			userId,
			cardId,
			mode: r.mode ?? ('review' as const),
			rating: r.correct ? ('good' as const) : ('again' as const),
			correct: r.correct,
			predictedRecall: r.predicted,
			gradedBy: r.gradedBy ?? 'self',
			overriddenAt: r.overridden ? ago(1) : null,
			reviewedAt: ago(r.daysAgo ?? 2),
			nextDueAt: now,
		})),
	)
	const summary = await asUser(userId, (tx) => progressSummary(tx, userId, 84, now))
	expect(summary.schedulerFit.map(({ predicted, ...b }) => ({ ...b, predicted: Math.round(predicted * 1000) / 1000 }))).toEqual([
		{ bucket: 0, answers: 1, right: 0, predicted: 0.05 },
		{ bucket: 6, answers: 2, right: 1, predicted: 0.65 },
		{ bucket: 9, answers: 4, right: 3, predicted: 0.94 },
	])
	expect(summary.honesty).toEqual({ counted: 1, checked: 4, reported: 0 })
	expect(summary.reading).toMatchObject({ finished: 0, words: 0 })
	expect(summary.reading.weeks).toHaveLength(13)
	expect(summary.reading.weeks.every((w) => w.minutes === 0)).toBe(true)
})
