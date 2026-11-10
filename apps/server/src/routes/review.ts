import { defaultScheduler, isQuestionType, questionTypes } from '@life-log-club/domain'
import { ORPCError } from '@orpc/server'
import { and, asc, count, desc, eq, gt, isNotNull, isNull } from 'drizzle-orm'
import { asUser, type Tx } from '../db/client'
import { cards, entries, questions, readings, sections } from '../db/schema'
import { enqueueIdeaCue, enqueueTopUp, enqueueWriteSection } from '../jobs'
import { answerCard, overrideAnswer, reportQuestion } from '../learning/answer'
import { dueNow, minutesFor, nextBatch } from '../learning/review'
import { saveIdea } from '../learning/saved-ideas'
import { startRewrite } from '../learning/write-section'
import { authed } from '../orpc'

const toCard = (c: typeof cards.$inferSelect) => ({
	id: c.id,
	kind: c.kind,
	prompt: c.prompt,
	answer: c.answer,
	entryId: c.entryId,
	readingId: c.readingId,
	sectionId: c.sectionId,
	quote: c.quote,
	dueAt: c.dueAt,
})

/** Only ideas the member saved are theirs to edit or remove here; lessons go with their entry. */
const savedIdea = (id: string) => and(eq(cards.id, id), eq(cards.kind, 'idea'), eq(cards.origin, 'member'))
const notFound = () => new ORPCError('NOT_FOUND', { message: 'That idea does not exist. It may have been removed.' })

async function liveSavedIdea(tx: Tx, id: string) {
	const [card] = await tx.select().from(cards).where(and(savedIdea(id), isNull(cards.deletedAt)))
	if (!card) throw notFound()
	return card
}

export const reviewRoutes = {
	add: authed.review.add.handler(async ({ input, context }) => {
		const { readingId, sectionId, quote } = input
		if (quote && readingId && sectionId) {
			const { card, needsCue } = await asUser(context.user.id, (tx) => saveIdea(tx, context.user.id, { ...input, readingId, sectionId, quote }))
			if (needsCue) await enqueueIdeaCue({ userId: context.user.id, cardId: card.id })
			return toCard(card)
		}
		const { prompt, answer } = input
		// The contract asks for both when there is no quote.
		if (!prompt || !answer) throw new ORPCError('BAD_REQUEST', { message: 'Give a question and its answer.' })
		return asUser(context.user.id, async (tx) => {
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
					prompt,
					answer,
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
		})
	}),

	update: authed.review.update.handler(({ input, context }) =>
		asUser(context.user.id, async (tx) => {
			const card = await liveSavedIdea(tx, input.id)
			const set = { ...(input.prompt && { prompt: input.prompt }), ...(input.answer && { answer: input.answer }) }
			if (!Object.keys(set).length) return toCard(card)
			const [updated] = await tx.update(cards).set(set).where(eq(cards.id, card.id)).returning()
			return toCard(updated!)
		}),
	),

	remove: authed.review.remove.handler(({ input, context }) =>
		asUser(context.user.id, async (tx) => {
			const card = await liveSavedIdea(tx, input.id)
			await tx.update(cards).set({ deletedAt: new Date() }).where(eq(cards.id, card.id))
			return { ok: true as const }
		}),
	),

	restore: authed.review.restore.handler(({ input, context }) =>
		asUser(context.user.id, async (tx) => {
			const [card] = await tx.update(cards).set({ deletedAt: null }).where(savedIdea(input.id)).returning()
			if (!card) throw notFound()
			return toCard(card)
		}),
	),

	list: authed.review.list.handler(({ input, context }) =>
		asUser(context.user.id, async (tx) => {
			const rows = await tx
				.select({ card: cards, readingTitle: readings.title, sectionTitle: sections.title })
				.from(cards)
				.leftJoin(readings, eq(readings.id, cards.readingId))
				.leftJoin(sections, eq(sections.id, cards.sectionId))
				.where(
					and(
						isNull(cards.deletedAt),
						isNull(readings.deletedAt),
						input.readingId ? eq(cards.readingId, input.readingId) : undefined,
						input.origin ? eq(cards.origin, input.origin) : undefined,
						input.kind ? eq(cards.kind, input.kind) : undefined,
					),
				)
				.orderBy(desc(cards.createdAt), desc(cards.id))
			return rows.map(({ card, readingTitle, sectionTitle }) => {
				const block = (card.details as { block?: unknown } | null)?.block
				return { ...toCard(card), readingTitle, sectionTitle, block: typeof block === 'number' ? block : null, createdAt: card.createdAt }
			})
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

	next: authed.review.next.handler(({ input, context }) => asUser(context.user.id, (tx) => nextBatch(tx, input.limit, input.filter, input.first))),

	bringForward: authed.review.bringForward.handler(({ input, context }) =>
		asUser(context.user.id, async (tx) => {
			const now = new Date()
			const live = and(eq(cards.id, input.id), isNull(cards.deletedAt))
			const [moved] = await tx
				.update(cards)
				.set({ dueAt: now })
				.where(and(live, isNotNull(cards.startedAt), gt(cards.dueAt, now)))
				.returning({ dueAt: cards.dueAt })
			if (moved) return moved
			const [card] = await tx.select({ dueAt: cards.dueAt, startedAt: cards.startedAt }).from(cards).where(live)
			if (!card) throw new ORPCError('NOT_FOUND', { message: 'That card does not exist. It may have been removed.' })
			if (!card.startedAt) throw new ORPCError('CONFLICT', { message: 'This card is not in review yet.' })
			return { dueAt: card.dueAt }
		}),
	),

	answer: authed.review.answer.handler(async ({ input, context }) => {
		const result = await answerCard(context.user.id, input)
		// A Review answer may use up a card's last unasked question: top up a few minutes later.
		if (input.mode === 'review') await enqueueTopUp(context.user.id)
		return result
	}),

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
			// A choice is checked against its key in code; only written answers have points to tick.
			if (!('mustHave' in parsed.data)) throw new ORPCError('BAD_REQUEST', { message: 'This question is checked without a checklist.' })
			const { reference, mustHave } = parsed.data
			// The same points the answer is graded against: a question with none is one point, its model answer.
			return { reference, points: mustHave.length ? mustHave : [reference], quote: card.quote }
		}),
	),
}

export const questionRoutes = {
	report: authed.questions.report.handler(({ input, context }) => reportQuestion(context.user.id, input)),

	rewrite: authed.questions.rewrite.handler(async ({ input, context }) => {
		const job = await asUser(context.user.id, (tx) => startRewrite(tx, context.user.id, input.sectionId, input.ideas))
		await enqueueWriteSection(job)
		return { ok: true as const }
	}),
}
