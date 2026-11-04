export type Rating = 'again' | 'hard' | 'good' | 'easy'

export type ReviewState = {
	/** Index into the fixed learning steps; null once the card has graduated. */
	step: number | null
	intervalDays: number
	ease: number
	reps: number
	lapses: number
}

export type Scheduler = {
	initial(): ReviewState
	next(state: ReviewState, rating: Rating, now: Date): { state: ReviewState; dueAt: Date }
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
