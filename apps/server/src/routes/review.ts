import { defaultScheduler, isQuestionType, questionTypes } from '@life-log-club/domain'
import { ORPCError } from '@orpc/server'
import { and, asc, count, eq, isNull } from 'drizzle-orm'
import { asUser } from '../db/client'
import { cards, entries, questions } from '../db/schema'
import { answerCard, overrideAnswer, reportQuestion } from '../learning/answer'
import { dueNow, minutesFor, nextBatch } from '../learning/review'
import { authed } from '../orpc'

const toCard = (c: typeof cards.$inferSelect) => ({
	id: c.id,
	kind: c.kind,
	prompt: c.prompt,
	answer: c.answer,
	entryId: c.entryId,
	dueAt: c.dueAt,
})

export const reviewRoutes = {
	add: authed.review.add.handler(({ input, context }) =>
		asUser(context.user.id, async (tx) => {
			// A foreign key alone would accept another member's entry id, because constraint
			// checks skip row-level security. Looking it up here only finds this member's own.
			if (input.entryId) {
				const [entry] = await tx
					.select({ id: entries.id })
					.from(entries)
					.where(and(eq(entries.id, input.entryId), isNull(entries.deletedAt)))
				if (!entry) throw new ORPCError('NOT_FOUND', { message: 'That entry does not exist.' })
			}
			const [created] = await tx
				.insert(cards)
				.values({
					id: input.id,
					userId: context.user.id,
					kind: input.kind,
					prompt: input.prompt,
					answer: input.answer,
					entryId: input.entryId ?? null,
					state: defaultScheduler.initial(),
					// A card added by hand is recalled from now on, so it starts at once.
					startedAt: new Date(),
				})
				.onConflictDoNothing()
				.returning()
			if (created) return toCard(created)
			const [existing] = await tx.select().from(cards).where(eq(cards.id, input.id))
			if (!existing) throw new ORPCError('CONFLICT', { message: 'That card id is taken. Try again.' })
			return toCard(existing)
		}),
	),

	due: authed.review.due.handler(({ input, context }) =>
		asUser(context.user.id, async (tx) => {
			const rows = await tx.select().from(cards).where(dueNow()).orderBy(asc(cards.dueAt)).limit(input.limit)
			const [total] = await tx.select({ n: count() }).from(cards).where(dueNow())
			const n = total?.n ?? 0
			return { cards: rows.map(toCard), total: n, minutes: await minutesFor(tx, n) }
		}),
	),

	next: authed.review.next.handler(({ input, context }) => asUser(context.user.id, (tx) => nextBatch(tx, input.limit, input.filter))),

	answer: authed.review.answer.handler(({ input, context }) => answerCard(context.user.id, input)),

	override: authed.review.override.handler(({ input, context }) => overrideAnswer(context.user.id, input.answerId)),

	checklist: authed.review.checklist.handler(({ input, context }) =>
		asUser(context.user.id, async (tx) => {
			const [card] = await tx.select().from(cards).where(and(eq(cards.id, input.cardId), isNull(cards.deletedAt)))
			if (!card) throw new ORPCError('NOT_FOUND', { message: 'That card does not exist. It may have been removed.' })
			// A cue is checked against the idea itself, as one point.
			if (!input.questionId) return { reference: card.answer, points: [card.answer], quote: card.quote }
			const [question] = await tx.select().from(questions).where(and(eq(questions.id, input.questionId), eq(questions.cardId, card.id)))
			const parsed = question && isQuestionType(question.type) ? questionTypes[question.type].content.safeParse(question.content) : null
			if (!parsed?.success) throw new ORPCError('NOT_FOUND', { message: 'That question does not exist.' })
			const { reference, mustHave } = parsed.data
			// The same points the answer is graded against: a question with none is one point, its model answer.
			return { reference, points: mustHave.length ? mustHave : [reference], quote: card.quote }
		}),
	),
}

export const questionRoutes = {
	report: authed.questions.report.handler(({ input, context }) => reportQuestion(context.user.id, input)),
}
