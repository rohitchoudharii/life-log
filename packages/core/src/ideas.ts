import { QUESTION_LEVELS, type QuestionLevel } from './questions'
import { defaultScheduler, type Rating, type ReviewState, type Scheduler } from './scheduler'

/** Correct recalls on separate local days, after the day an idea was first studied, that make it learned. */
export const MASTERY_DAYS = 3
/** How often a learned idea comes back. */
export const MASTERED_INTERVAL_DAYS = 30

/** An idea's review schedule. Days are local calendar days, YYYY-MM-DD. */
export type IdeaSchedule = {
	state: ReviewState
	/** Index into QUESTION_LEVELS: how hard the next question on this idea should be. */
	level: number
	/** The day the idea was first answered; correct answers that day do not count toward mastery. */
	firstDay: string
	/** Distinct later days with a correct, scheduled recall. */
	correctDays: string[]
	mastered: boolean
}

/** The local calendar day of an instant in a timezone, as YYYY-MM-DD. */
export const localDay = (at: Date, tz: string) => at.toLocaleDateString('en-CA', { timeZone: tz })

export const levelIndex = (level: QuestionLevel | null) => Math.max(0, QUESTION_LEVELS.indexOf(level ?? 'recall'))

export function startIdea(level: QuestionLevel | null, day: string, scheduler: Scheduler = defaultScheduler): IdeaSchedule {
	return { state: scheduler.initial(), level: levelIndex(level), firstDay: day, correctDays: [], mastered: false }
}

/**
 * Applies one answer to an idea's schedule. Right moves the idea up a level and spaces it out;
 * wrong moves it down, brings it back soon, and restarts the count toward mastery. A right answer before the idea is due (a second
 * question on the same idea in one test) changes nothing; a wrong one always counts.
 */
export function reviewIdea(
	prev: { schedule: IdeaSchedule; dueAt: Date },
	grade: { correct: boolean; rating: Rating },
	now: Date,
	day: string,
	scheduler: Scheduler = defaultScheduler,
): { schedule: IdeaSchedule; dueAt: Date } {
	const due = prev.dueAt.getTime() <= now.getTime()
	if (grade.correct && !due) return prev
	const s = prev.schedule
	const { state, dueAt } = scheduler.next(s.state, grade.rating, now)
	const top = QUESTION_LEVELS.length - 1
	if (!grade.correct)
		return {
			schedule: { ...s, state, level: Math.max(0, s.level - 1), correctDays: [], mastered: false },
			dueAt,
		}
	const correctDays = day === s.firstDay || s.correctDays.includes(day) ? s.correctDays : [...s.correctDays, day]
	const mastered = correctDays.length >= MASTERY_DAYS
	return {
		schedule: { ...s, state, level: Math.min(top, s.level + 1), correctDays, mastered },
		dueAt: mastered ? new Date(now.getTime() + MASTERED_INTERVAL_DAYS * 86_400_000) : dueAt,
	}
}

export type QuestionChoice = { id: string; level: QuestionLevel | null; lastAskedAt: Date | null }

/**
 * Picks the question to ask on a due idea: one never asked, at the idea's level or the nearest
 * one (lower first, so a struggling idea gets an easier question). Returns null when every
 * question has been asked, so the caller can write a new one. With `reuse`, falls back to the
 * longest-unasked question other than the last one asked.
 */
export function pickQuestion(choices: QuestionChoice[], level: number, lastId: string | null, reuse = false): string | null {
	const distance = (q: QuestionChoice) => {
		const d = levelIndex(q.level) - level
		return d < 0 ? -d * 2 - 1 : d * 2
	}
	const fresh = choices.filter((q) => !q.lastAskedAt)
	if (fresh.length) return fresh.reduce((a, b) => (distance(b) < distance(a) ? b : a)).id
	if (!reuse) return null
	const pool = choices.length > 1 ? choices.filter((q) => q.id !== lastId) : choices
	if (!pool.length) return null
	return pool.reduce((a, b) => (b.lastAskedAt!.getTime() < a.lastAskedAt!.getTime() ? b : a)).id
}
