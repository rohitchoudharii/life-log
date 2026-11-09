import { QUESTION_LEVELS, type QuestionLevel } from './questions'
import { defaultScheduler, type Rating, type Scheduler, type SchedulerState } from './scheduler'

export const levelIndex = (level: QuestionLevel | null) => Math.max(0, QUESTION_LEVELS.indexOf(level ?? 'recall'))
const TOP_LEVEL = QUESTION_LEVELS.length - 1

/** What one card needs to apply an answer: its schedule, its level and when it is due. */
export type IdeaProgress = { state: SchedulerState; level: number; dueAt: Date }

/**
 * Applies one answer to a card. Right moves it up a level and spaces it out; wrong moves it down
 * and brings it back soon. A right answer before the card is due (a second question on the same
 * idea in one sitting) changes nothing, so only the first answer sets the schedule; a wrong one
 * always counts.
 */
export function answerIdea(
	prev: IdeaProgress,
	grade: { correct: boolean; rating: Rating },
	now: Date,
	scheduler: Scheduler = defaultScheduler,
): IdeaProgress {
	if (grade.correct && prev.dueAt.getTime() > now.getTime()) return prev
	const { state, dueAt } = scheduler.next(prev.state, grade.rating, now)
	const level = grade.correct ? Math.min(TOP_LEVEL, prev.level + 1) : Math.max(0, prev.level - 1)
	return { state, level, dueAt }
}

export type QuestionChoice = { id: string; level: QuestionLevel | null; lastAskedAt: Date | null }

/**
 * Picks the question to ask on a due card: one never asked, at the card's level or the nearest
 * one (lower first, so a struggling idea gets an easier question). Returns null when every
 * question has been asked, so the caller can use the cue or write a new one. With `reuse`, falls
 * back to the longest-unasked question other than the last one asked.
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
