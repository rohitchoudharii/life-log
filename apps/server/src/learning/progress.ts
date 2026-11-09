import type { MindSummary, ProgressSummary } from '@life-log-club/contract'
import { GAP_BUCKETS, gapBucket, ideaStatus, isGraduated, recallNow, type IdeaStatus } from '@life-log-club/domain'
import { and, asc, eq, gt, gte, isNotNull, isNull, sql } from 'drizzle-orm'
import type { Tx } from '../db/client'
import { cards, readings, recallAttempts, reviewLog, sections } from '../db/schema'
import { preferencesOf } from './preferences'

const DAY = 86_400_000
const ago = (now: Date, days: number) => new Date(now.getTime() - days * DAY)

type Answer = { at: Date; right: boolean; graduated: boolean; gapDays: number | null }

/**
 * Review answers since `since` that measure recall: the first answer of the day (UTC) to each
 * card in Review, leaving out ones the member counted as right. Reported answers are already
 * practice, so they never count. Each says whether the card was past the steps when answered,
 * and how many days after the card's previous answer it came.
 */
async function reviewAnswers(tx: Tx, since: Date): Promise<Answer[]> {
	const day = sql`(${reviewLog.reviewedAt} at time zone 'UTC')::date`
	const rows = await tx
		.selectDistinctOn([reviewLog.cardId, day], {
			at: reviewLog.reviewedAt,
			right: sql<boolean>`coalesce(${reviewLog.correct}, ${reviewLog.rating} <> 'again')`,
			overriddenAt: reviewLog.overriddenAt,
			prev: reviewLog.prev,
		})
		.from(reviewLog)
		.where(and(eq(reviewLog.mode, 'review'), gte(reviewLog.reviewedAt, since)))
		.orderBy(reviewLog.cardId, day, asc(reviewLog.reviewedAt), asc(reviewLog.id))
	return rows
		.filter((r) => !r.overriddenAt)
		.map((r) => {
			const last = r.prev?.state.lastReviewAt
			return {
				at: r.at,
				right: r.right,
				graduated: r.prev !== null && r.prev.state.step === null,
				gapDays: last ? (r.at.getTime() - Date.parse(last)) / DAY : null,
			}
		})
}

const rightOf = (answers: Answer[]) => ({ right: answers.filter((a) => a.right).length, total: answers.length })

/** Monday 00:00 UTC of the week `at` falls in. */
function weekOf(at: Date) {
	const d = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()))
	d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7))
	return d
}

const noIdeas = (): Record<IdeaStatus, number> => ({ new: 0, learning: 0, known: 0, fading: 0 })

/** The Progress page for the member in `tx`, over the last `days` days. */
export async function progressSummary(tx: Tx, userId: string, days: number, now = new Date()): Promise<ProgressSummary> {
	const answers = await reviewAnswers(tx, ago(now, days))

	const atReview = answers.filter((a) => a.graduated)
	const weeks = new Map<number, Answer[]>()
	for (const a of atReview) {
		const week = weekOf(a.at).getTime()
		weeks.set(week, [...(weeks.get(week) ?? []), a])
	}

	const byGap = GAP_BUCKETS.map((gap) => ({ gap, ...rightOf(answers.filter((a) => a.gapDays !== null && gapBucket(a.gapDays) === gap)) }))

	const all = await tx
		.select({ readingId: cards.readingId, title: readings.title, startedAt: cards.startedAt, state: cards.state })
		.from(cards)
		.leftJoin(readings, eq(readings.id, cards.readingId))
		.where(isNull(cards.deletedAt))
	const total = noIdeas()
	const perReading = new Map<string, { readingId: string; title: string; counts: Record<IdeaStatus, number> }>()
	for (const card of all) {
		const status = ideaStatus(card, now)
		total[status]++
		if (!card.readingId) continue
		const reading = perReading.get(card.readingId) ?? { readingId: card.readingId, title: card.title ?? '', counts: noIdeas() }
		reading.counts[status]++
		perReading.set(card.readingId, reading)
	}

	const attempts = await tx
		.select({ attemptId: recallAttempts.id, at: recallAttempts.submittedAt, reading: readings.title, results: recallAttempts.results })
		.from(recallAttempts)
		.innerJoin(readings, eq(readings.id, recallAttempts.readingId))
		.where(and(isNotNull(recallAttempts.results), gte(recallAttempts.submittedAt, ago(now, days))))
		.orderBy(asc(recallAttempts.submittedAt))
	const dumps = attempts
		.filter((a) => a.results?.length)
		.map((a) => ({ attemptId: a.attemptId, at: a.at!, reading: a.reading, covered: a.results!.filter((r) => r.status === 'covered').length, total: a.results!.length }))

	return {
		ideas: { total, readings: [...perReading.values()].sort((a, b) => a.title.localeCompare(b.title)) },
		recallAtReview: {
			...rightOf(atReview),
			target: (await preferencesOf(tx, userId)).desiredRetention,
			weeks: [...weeks.entries()].sort(([a], [b]) => a - b).map(([week, list]) => ({ week: new Date(week), ...rightOf(list) })),
		},
		recallByGap: byGap,
		dumps,
	}
}

/** Fading ideas and the 30-day recall at review, for Mind and the Home card. */
export async function mindSummary(tx: Tx, now = new Date()): Promise<MindSummary> {
	const waiting = await tx
		.select({ cardId: cards.id, prompt: cards.prompt, startedAt: cards.startedAt, state: cards.state, reading: readings.title, section: sections.title })
		.from(cards)
		.leftJoin(readings, eq(readings.id, cards.readingId))
		.leftJoin(sections, eq(sections.id, cards.sectionId))
		.where(and(isNull(cards.deletedAt), isNotNull(cards.startedAt), gt(cards.dueAt, now)))
	const fading = waiting
		.filter(isGraduated)
		.map((c) => ({ cardId: c.cardId, prompt: c.prompt, source: c.reading ? { reading: c.reading, section: c.section } : null, recall: recallNow(c.state, now) ?? 0 }))
		.sort((a, b) => a.recall - b.recall)
		.slice(0, 3)
	const recent = (await reviewAnswers(tx, ago(now, 30))).filter((a) => a.graduated)
	return { fading, recall30d: rightOf(recent) }
}
