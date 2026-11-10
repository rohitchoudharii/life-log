import type { Confidence } from './questions'
import { defaultScheduler, type SchedulerState } from './scheduler'

/** Where an idea stands: not started, in the 1, 2 and 3 day steps, or past them and known or fading. */
export const IDEA_STATUSES = ['new', 'learning', 'known', 'fading'] as const
export type IdeaStatus = (typeof IDEA_STATUSES)[number]

/** A graduated idea is known while its predicted recall now is at least this, and fading below it. */
export const KNOWN_RECALL = 0.85

/** A recall rate is shown once it rests on this many reviews; fewer would be noise. */
export const RECALL_MIN_REVIEWS = 20

/** The predicted chance of recalling a card now, or null when it has never been answered. */
export const recallNow = (state: SchedulerState, now: Date) => defaultScheduler.retrievability(state, now)

/** Whether a card is past the 1, 2 and 3 day steps. A card relearning after a lapse still is. */
export const isGraduated = (card: { startedAt: Date | null; state: SchedulerState }) => card.startedAt !== null && card.state.step === null

/** The status of one card now (see `IDEA_STATUSES`). */
export function ideaStatus(card: { startedAt: Date | null; state: SchedulerState }, now: Date): IdeaStatus {
	if (!card.startedAt) return 'new'
	if (card.state.step !== null) return 'learning'
	return (recallNow(card.state, now) ?? 0) >= KNOWN_RECALL ? 'known' : 'fading'
}

/** Groups for "recall by gap": the 1, 2 and 3 day steps, then ever longer gaps. */
export const GAP_BUCKETS = ['1d', '2d', '3d', 'month', 'quarter', 'longer'] as const
export type GapBucket = (typeof GAP_BUCKETS)[number]

/**
 * The group for an answer given `days` after the one before it. A gap is counted in whole days,
 * rounded, so an answer a few hours early or late for its step still falls in that step's group.
 */
export function gapBucket(days: number): GapBucket {
	const d = Math.round(days)
	if (d <= 1) return '1d'
	if (d === 2) return '2d'
	if (d === 3) return '3d'
	if (d <= 28) return 'month'
	if (d <= 91) return 'quarter'
	return 'longer'
}

/** Words to a page, for a goal's pace. */
export const WORDS_PER_PAGE = 300

/**
 * How a reading stands against its goal date on `today` (both YYYY-MM-DD, UTC): the share read,
 * and the pages a day left to finish by the end of the goal day, counting today. `passed` once
 * the goal day is over.
 */
export function goalPace({ wordCount, wordsRead, goalBy, today }: { wordCount: number; wordsRead: number; goalBy: string; today: string }) {
	const percent = wordCount ? Math.min(100, Math.round((wordsRead / wordCount) * 100)) : 0
	const days = Math.round((Date.parse(goalBy) - Date.parse(today)) / 86_400_000) + 1
	if (days < 1) return { percent, passed: true as const }
	const pages = Math.ceil(Math.max(0, wordCount - wordsRead) / WORDS_PER_PAGE / days)
	return { percent, passed: false as const, pagesPerDay: pages }
}

/** How many answers at each confidence were right. */
export type Calibration = Record<Confidence, { right: number; total: number }>

/** Tallies answers by the confidence given with them. Answers with no confidence, such as self-rated ones, are left out. */
export function calibration(answers: { confidence: Confidence | null; correct: boolean }[]): Calibration {
	const out: Calibration = { sure: { right: 0, total: 0 }, think_so: { right: 0, total: 0 }, guessing: { right: 0, total: 0 } }
	for (const a of answers) {
		if (!a.confidence) continue
		out[a.confidence].total++
		if (a.correct) out[a.confidence].right++
	}
	return out
}

const CALIBRATION_LABELS: [Confidence, string][] = [
	['sure', 'Sure'],
	['think_so', 'Think so'],
	['guessing', 'Guessing'],
]

/**
 * "Sure: 4 of 5 right · Think so: 2 of 3 · Guessing: 1 of 2", leaving out levels with no answers;
 * empty when there are none. A level with at least `percentFrom` answers shows a percentage
 * instead, as in "Sure: 91% right".
 */
export function calibrationLine(c: Calibration, percentFrom = Number.POSITIVE_INFINITY) {
	return CALIBRATION_LABELS.filter(([level]) => c[level].total > 0)
		.map(([level, label], i) => {
			const { right, total } = c[level]
			const share = total >= percentFrom ? `${Math.round((right / total) * 100)}%` : `${right} of ${total}`
			return `${label}: ${share}${i === 0 ? ' right' : ''}`
		})
		.join(' · ')
}
