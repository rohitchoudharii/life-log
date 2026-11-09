import { fnv1aMulberry32Rng, getFuzzRange } from 'ts-fsrs'
import { FSRS6_DEFAULT_WEIGHTS, FSRS6_MODEL_BOUNDS, FSRS6Algorithm } from 'ts-fsrs/models/fsrs-6'

export type Rating = 'again' | 'hard' | 'good' | 'easy'

export type ReviewState = {
	/** Index into the fixed learning steps; null once the card has graduated. */
	step: number | null
	intervalDays: number
	ease: number
	reps: number
	lapses: number
}

/**
 * Decides when a card comes back from its state and each rating. `id` names the rules and their
 * version, and is written with every answer it schedules. `retrievability` is the predicted
 * chance of recall at `now`, or null when the rules can't predict it.
 */
export type Scheduler<S = ReviewState> = {
	id: string
	initial(): S
	next(state: S, rating: Rating, now: Date): { state: S; dueAt: Date }
	retrievability(state: S, now: Date): number | null
}

const DAY = 24 * 60 * 60 * 1000
const MINUTE = 60 * 1000

/**
 * Fixed steps of 1, 2, and 3 days (the repeats you asked for), then intervals that grow by
 * an ease factor that adapts to your ratings, like SM-2. Swap in FSRS behind `Scheduler` later.
 */
export function stepsThenEase(steps = [1, 2, 3], maxIntervalDays = 365): Scheduler {
	const graduate = (state: ReviewState, days: number) => ({
		...state,
		step: null,
		intervalDays: Math.min(days, maxIntervalDays),
	})
	return {
		id: 'steps-ease-v1',
		// Ease has no model of forgetting, so it can't say how likely recall is.
		retrievability: () => null,
		initial: () => ({ step: 0, intervalDays: 0, ease: 2.5, reps: 0, lapses: 0 }),
		next(prev, rating, now) {
			let state: ReviewState = { ...prev, reps: prev.reps + 1 }
			if (rating === 'again') {
				// Forgotten: start the steps over and see it again in this session.
				const lapsed = prev.step === null
				state = {
					...state,
					step: 0,
					intervalDays: 0,
					lapses: prev.lapses + (lapsed ? 1 : 0),
					ease: lapsed ? Math.max(1.3, prev.ease - 0.2) : prev.ease,
				}
				return { state, dueAt: new Date(now.getTime() + 10 * MINUTE) }
			}
			if (prev.step !== null) {
				// "good" takes the current step, "hard" repeats the previous one, "easy" skips ahead.
				const s = prev.step
				const last = steps.length - 1
				const idx = rating === 'hard' ? Math.max(s - 1, 0) : rating === 'good' ? s : Math.min(s + 1, last)
				const days = steps[idx]!
				const nextStep = rating === 'hard' ? s : rating === 'good' ? s + 1 : s + 2
				state = nextStep > last ? graduate(state, days) : { ...state, step: nextStep, intervalDays: days }
				if (rating === 'easy') state.ease = prev.ease + 0.15
				return { state, dueAt: new Date(now.getTime() + days * DAY) }
			}
			const base = Math.max(prev.intervalDays, 1)
			const factor = rating === 'hard' ? 1.2 : rating === 'good' ? prev.ease : prev.ease * 1.3
			const ease =
				rating === 'hard' ? Math.max(1.3, prev.ease - 0.15) : rating === 'easy' ? prev.ease + 0.15 : prev.ease
			state = graduate({ ...state, ease }, Math.round(base * factor))
			return { state, dueAt: new Date(now.getTime() + state.intervalDays * DAY) }
		},
	}
}

export const defaultScheduler = stepsThenEase()

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
}: { desiredRetention?: number; maxIntervalDays?: number; fuzz?: boolean; steps?: number[] } = {}): Scheduler<SchedulerState> {
	// Short-term stability is for reviews minutes apart, which only the 10-minute retry is.
	const fsrs = new FSRS6Algorithm([...FSRS6_DEFAULT_WEIGHTS], false, FSRS6_MODEL_BOUNDS)
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
		id: `steps-fsrs-v1:${FSRS_MODEL}`,
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
