import type { Answer, AnswerResult, Reveal } from '@life-log-club/contract'
import {
	answerIdea,
	type Grade,
	gradeResponse,
	gradeWritten,
	isQuestionType,
	type Judge,
	type PointStatus,
	withConfidence,
} from '@life-log-club/domain'
import { judgeRequest, parseJudgeVerdict } from '@life-log-club/llm'
import { ORPCError } from '@orpc/server'
import { and, eq, isNull } from 'drizzle-orm'
import { ZodError } from 'zod'
import { asUser, type Tx } from '../db/client'
import { cards, questions, recallAttempts, reviewLog } from '../db/schema'
import { callAi } from './ai'

const NOT_CHECKED = 'Your answer couldn’t be checked just now. Try again in a moment.'

/** A judge that grades with the member's own key. The score is always computed in code. */
export const judgeFor =
	(userId: string): Judge =>
	async (input) => {
		let reply: string | null
		try {
			reply = await callAi(userId, 'judge-answer', (model) => judgeRequest(model, input))
		} catch {
			throw new ORPCError('SERVICE_UNAVAILABLE', { message: NOT_CHECKED })
		}
		if (reply === null) throw new ORPCError('BAD_REQUEST', { message: 'Add your own AI key in Settings to have written answers checked.' })
		const verdict = parseJudgeVerdict(reply, input)
		if (!verdict) throw new ORPCError('SERVICE_UNAVAILABLE', { message: NOT_CHECKED })
		return verdict
	}

/** The result tile from a grade's reveal: the model answer, each must-have point with its status, the quote. */
function toReveal(reveal: Record<string, unknown>, quote: string | null): Reveal {
	const mustHave = Array.isArray(reveal.mustHave) ? (reveal.mustHave as string[]) : []
	const points = Array.isArray(reveal.points) ? (reveal.points as PointStatus[]) : []
	return {
		reference: typeof reveal.reference === 'string' ? reveal.reference : null,
		feedback: typeof reveal.feedback === 'string' ? reveal.feedback : '',
		points: mustHave.map((point, i) => ({ point, status: points[i] ?? 'missing' })),
		misconception: typeof reveal.misconception === 'string' ? reveal.misconception : null,
		quote,
	}
}

/** The result of an answer already recorded, so the same answer sent twice counts once. */
async function recorded(tx: Tx, answerId: string): Promise<AnswerResult | null> {
	const [row] = await tx.select().from(reviewLog).where(eq(reviewLog.answerId, answerId))
	if (!row) return null
	return {
		correct: row.correct ?? row.rating !== 'again',
		rating: row.rating,
		reveal: row.reveal ?? { reference: null, feedback: '', points: [], misconception: null, quote: null },
		dueAt: row.nextDueAt,
	}
}

/**
 * Review answers only cards that have started and are due. Recall and practice answer at any
 * time: recall starts a card, and practice leaves the schedule as it is.
 */
function checkWhen(card: typeof cards.$inferSelect, mode: Answer['mode'], now: Date) {
	if (mode !== 'review') return
	if (!card.startedAt) throw new ORPCError('CONFLICT', { message: 'This card is not in review yet.' })
	if (card.dueAt > now) throw new ORPCError('CONFLICT', { message: 'This card is not due yet.' })
}

/**
 * Records one answer: grades it (in code, by the member's AI judge, or by the member's own
 * rating), applies confidence, moves the card's schedule and level, and logs it. The AI call is
 * made outside the transaction that locks the card, so a slow judge holds no lock.
 */
export async function answerCard(userId: string, input: Answer): Promise<AnswerResult> {
	const already = await asUser(userId, (tx) => recorded(tx, input.answerId))
	if (already) return already
	const { card, question } = await asUser(userId, async (tx) => {
		const [card] = await tx.select().from(cards).where(and(eq(cards.id, input.cardId), isNull(cards.deletedAt)))
		if (!card) throw new ORPCError('NOT_FOUND', { message: 'That card does not exist. It may have been removed.' })
		// Foreign keys skip row-level security; looking the attempt up here finds only this member's.
		if (input.attemptId) {
			const [attempt] = await tx.select({ id: recallAttempts.id }).from(recallAttempts).where(eq(recallAttempts.id, input.attemptId))
			if (!attempt) throw new ORPCError('NOT_FOUND', { message: 'That recall check does not exist.' })
		}
		checkWhen(card, input.mode, new Date())
		if (input.ask !== 'question') return { card, question: null }
		const [question] = await tx.select().from(questions).where(and(eq(questions.id, input.questionId), eq(questions.cardId, card.id)))
		if (!question || !isQuestionType(question.type)) throw new ORPCError('NOT_FOUND', { message: 'That question does not exist.' })
		return { card, question }
	})

	const judge = judgeFor(userId)
	let grade: Grade
	let gradedBy: 'code' | 'ai' | 'self'
	let response: Record<string, unknown> | null = null
	if (input.ask === 'self') {
		grade = { rating: input.rating, correct: input.rating === 'good' || input.rating === 'easy', reveal: { reference: card.answer } }
		gradedBy = 'self'
	} else {
		response = input.response
		const skipped = 'skipped' in input.response
		gradedBy = skipped ? 'code' : 'ai'
		try {
			grade =
				input.ask === 'cue'
					? await gradeWritten({ prompt: card.prompt, reference: card.answer, mustHave: [card.answer], misconceptions: [] }, input.response, judge)
					: await gradeResponse(question!.type as never, question!.content, input.response, judge)
		} catch (error) {
			if (error instanceof ZodError) throw new ORPCError('BAD_REQUEST', { message: 'Write an answer, or choose I don’t know.' })
			throw error
		}
		grade = withConfidence(grade, input.confidence)
	}
	const reveal = toReveal(grade.reveal, card.quote)

	return asUser(userId, async (tx) => {
		const now = new Date()
		const [locked] = await tx.select().from(cards).where(eq(cards.id, card.id)).for('update')
		const again = await recorded(tx, input.answerId)
		if (again) return again
		checkWhen(locked!, input.mode, now)
		let dueAt = locked!.dueAt
		if (input.mode !== 'practice') {
			const next = answerIdea({ state: locked!.state, level: locked!.level, dueAt: locked!.dueAt }, grade, now)
			dueAt = next.dueAt
			await tx
				.update(cards)
				.set({ state: next.state, level: next.level, dueAt, startedAt: locked!.startedAt ?? now })
				.where(eq(cards.id, card.id))
		}
		await tx.insert(reviewLog).values({
			userId,
			cardId: card.id,
			answerId: input.answerId,
			questionId: question?.id ?? null,
			attemptId: input.attemptId ?? null,
			ask: input.ask,
			mode: input.mode,
			rating: grade.rating,
			correct: grade.correct,
			response,
			confidence: input.ask === 'self' ? null : input.confidence,
			feedback: reveal.feedback || null,
			reveal,
			gradedBy,
			reviewedAt: now,
			nextDueAt: dueAt,
		})
		return { correct: grade.correct, rating: grade.rating, reveal, dueAt }
	})
}
