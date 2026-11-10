import { quoteInText } from './quality'

/** Follow-up questions the student asks before it sums up, so a session takes at most four AI calls. */
export const MAX_FOLLOW_UPS = 3

/** The longest single message the learner can send in a teach-back. */
export const MAX_TEACH_CHARS = 4000

export type TeachMessage = { role: 'learner' | 'student'; text: string }

/** What the student asks in place of a question that would give the idea away. */
export const SAFE_FOLLOW_UP = 'Can you say more about why?'

/**
 * The student's question as the learner sees it: one that contains the idea's quote or the idea
 * itself would hand the learner the answer, so it is replaced with a plain "why".
 */
export function safeFollowUp(question: string, card: { quote: string | null; idea: string }) {
	const leaks = [card.quote, card.idea].some((text) => text && quoteInText(text, question))
	return leaks ? SAFE_FOLLOW_UP : question
}
