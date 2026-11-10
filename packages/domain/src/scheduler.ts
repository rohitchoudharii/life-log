import { fnv1aMulberry32Rng, getFuzzRange } from 'ts-fsrs'
import { FSRS6_DEFAULT_WEIGHTS, FSRS6_MODEL_BOUNDS, FSRS6Algorithm } from 'ts-fsrs/models/fsrs-6'

export type Rating = 'again' | 'hard' | 'good' | 'easy'

/**
 * Decides when a card comes back from its state and each rating. `id` names the rules and their
 * version, and is written with every answer it schedules. `retrievability` is the predicted
 * chance of recall at `now`, or null when the rules can't predict it.
 */
export type Scheduler<S = SchedulerState> = {
	id: string
	initial(): S
	next(state: S, rating: Rating, now: Date): { state: S; dueAt: Date }
	retrievability(state: S, now: Date): number | null
}

const DAY = 24 * 60 * 60 * 1000
const MINUTE = 60 * 1000

/** The FSRS memory of a card: how long it lasts (days to 90% recall) and how hard it is (1 to 10). */
export type FsrsMemory = { stability: number; difficulty: number }

export type SchedulerState = {
	/** Index into the 1, 2, 3 day steps; null once the card has graduated. */
	step: number | null
	/** After a lapse: 0 while the 10-minute retry is next, 1 while the 1-day check is; else null. */
	relearning: 0 | 1 | null
	reps: number
	lapses: number
	/** Updated by every answer, the steps included; null before the first. */
	memory: FsrsMemory | null
	/** ISO time of the last answer. */
	lastReviewAt: string | null
}

const GRADE: Record<Rating, 1 | 2 | 3 | 4> = { again: 1, hard: 2, good: 3, easy: 4 }

/** The FSRS model version the gaps come from, written into `review_log.scheduler` with the rules. */
export const FSRS_MODEL = 'FSRS-6'

/** The FSRS-6 parameters every member starts with, until tuning finds better ones from their own reviews. */
export const FSRS_DEFAULT_WEIGHTS: readonly number[] = FSRS6_DEFAULT_WEIGHTS

/**
 * Fixed steps of 1, 2 and 3 days, then gaps from FSRS at the member's target recall
 * (`desiredRetention`), capped at `maxIntervalDays`. FSRS updates the card's memory on every
 * answer, the steps included, so it is well informed when the card graduates.
 *
 * - Steps: Got it moves to the next step; Hard repeats the step's gap; Forgot starts the steps
 *   over and brings the card back in 10 minutes.
 * - After graduation, a lapse brings the card back in 10 minutes, then 1 day, then FSRS again,
 *   rather than all three steps: FSRS has already cut its stability.
 * - Gaps from FSRS are fuzzed by a few percent, seeded by the card's state and the time, so ideas
 *   learned together drift apart, and the same answers replayed give the same gaps.
 */
export function stepsThenFsrs({
	desiredRetention = 0.9,
	maxIntervalDays = 365,
	fuzz = true,
	steps = [1, 2, 3],
	weights,
}: { desiredRetention?: number; maxIntervalDays?: number; fuzz?: boolean; steps?: number[]; weights?: readonly number[] | null } = {}): Scheduler<SchedulerState> {
	// Short-term stability is for reviews minutes apart, which only the 10-minute retry is.
	const fsrs = new FSRS6Algorithm([...(weights ?? FSRS6_DEFAULT_WEIGHTS)], false, FSRS6_MODEL_BOUNDS)
	const elapsedDays = (state: SchedulerState, now: Date) =>
		state.lastReviewAt ? Math.max(0, Math.floor((now.getTime() - Date.parse(state.lastReviewAt)) / DAY)) : 0
	const after = (now: Date, ms: number) => new Date(now.getTime() + ms)

	/** The FSRS gap in whole days for a memory, fuzzed and capped. */
	function fsrsDays(memory: FsrsMemory, elapsed: number, seed: string) {
		const days = Math.min(maxIntervalDays, Math.max(1, fsrs.next_interval(memory.stability, desiredRetention)))
		if (!fuzz || days < 3) return days
		const { minInterval, maxInterval } = getFuzzRange(days, elapsed, maxIntervalDays)
		return Math.min(maxIntervalDays, Math.floor(minInterval + fnv1aMulberry32Rng(seed)() * (maxInterval - minInterval + 1)))
	}

	return {
		// Tuned parameters are named in the log, so answers scheduled with them can be told apart.
		id: `steps-fsrs-v1:${FSRS_MODEL}${weights ? ':own' : ''}`,
		initial: () => ({ step: 0, relearning: null, reps: 0, lapses: 0, memory: null, lastReviewAt: null }),
		retrievability(state, now) {
			if (!state.memory || !state.lastReviewAt) return null
			const days = Math.max(0, (now.getTime() - Date.parse(state.lastReviewAt)) / DAY)
			return fsrs.forgetting_curve(days, state.memory.stability)
		},
		next(prev, rating, now) {
			const elapsed = elapsedDays(prev, now)
			const memory = fsrs.next_state(prev.memory, elapsed, GRADE[rating])
			const base = { ...prev, reps: prev.reps + 1, memory, lastReviewAt: now.toISOString() }
			const last = steps.length - 1

			if (prev.step !== null) {
				if (rating === 'again') return { state: { ...base, step: 0 }, dueAt: after(now, 10 * MINUTE) }
				const s = prev.step
				const idx = rating === 'hard' ? Math.max(s - 1, 0) : rating === 'good' ? s : Math.min(s + 1, last)
				const nextStep = rating === 'hard' ? s : rating === 'good' ? s + 1 : s + 2
				return { state: { ...base, step: nextStep > last ? null : nextStep }, dueAt: after(now, steps[idx]! * DAY) }
			}
			if (rating === 'again') {
				// A lapse counts once, when a graduated card is forgotten, not again while it is relearned.
				const lapses = prev.relearning === null ? prev.lapses + 1 : prev.lapses
				return { state: { ...base, lapses, relearning: 0 }, dueAt: after(now, 10 * MINUTE) }
			}
			if (prev.relearning === 0) {
				if (rating === 'hard') return { state: base, dueAt: after(now, 10 * MINUTE) }
				return { state: { ...base, relearning: 1 }, dueAt: after(now, DAY) }
			}
			if (prev.relearning === 1 && rating === 'hard') return { state: base, dueAt: after(now, DAY) }
			const days = fsrsDays(memory, elapsed, `${base.reps}:${now.toISOString()}:${memory.stability}`)
			return { state: { ...base, relearning: null }, dueAt: after(now, days * DAY) }
		},
	}
}

export const defaultScheduler = stepsThenFsrs()

const byTarget = new Map<string, Scheduler>([['0.9:', defaultScheduler]])
/**
 * The scheduler for a member's target recall and, once tuning has found them, their own FSRS
 * parameters. The target changes only the FSRS gaps; own parameters also change predicted recall.
 */
export function schedulerFor(desiredRetention: number, weights?: readonly number[] | null): Scheduler {
	const key = `${desiredRetention}:${weights?.join(',') ?? ''}`
	let scheduler = byTarget.get(key)
	if (!scheduler) byTarget.set(key, (scheduler = stepsThenFsrs({ desiredRetention, weights })))
	return scheduler
}

/** One logged answer, as a replay needs it. `correct` is null on answers from before it was kept. */
export type LoggedAnswer = { rating: Rating; correct: boolean | null; at: Date; mode: 'recall' | 'review' }

/**
 * A card's state and due time worked out again from its answers, in the order they were given,
 * through `scheduler`. As when answering, a right recall answer to a card that isn't due yet (a
 * second question on the same idea in one sitting) changes nothing, and a wrong one always counts.
 * A review answer always counts: the server took it only when the card was due, and the old
 * scheduler's due time can be earlier than this one's. Practice answers must be left out by the
 * caller. Null when there are no answers.
 */
export function replaySchedule(answers: LoggedAnswer[], scheduler: Scheduler = defaultScheduler): { state: SchedulerState; dueAt: Date } | null {
	let current: { state: SchedulerState; dueAt: Date } | null = null
	for (const a of answers) {
		const correct = a.correct ?? a.rating !== 'again'
		if (current && a.mode === 'recall' && correct && current.dueAt > a.at) continue
		current = scheduler.next(current?.state ?? scheduler.initial(), a.rating, a.at)
	}
	return current
}
