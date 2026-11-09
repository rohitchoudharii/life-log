import { defaultScheduler, replaySchedule, type SchedulerState } from '@life-log-club/domain'
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm'
import { ownerDb } from '../db/client'
import { cards, reviewLog } from '../db/schema'

/** What a replay did, to check against the spec's acceptance (learning_spec.md section 5.4). */
export type ReplayReport = {
	cards: number
	/** Cards with answers, whose schedule was worked out again from them. */
	replayed: number
	/** Started cards past the 1, 2 and 3 day steps, and how many of them have an FSRS memory (all should). */
	graduated: number
	graduatedWithMemory: number
	/** Started cards due now, before and after. */
	dueBefore: number
	dueAfter: number
	/** Cards still in the 1, 2 and 3 day steps whose due time changed (should be 0: the steps are the same). */
	dueAtChangedInSteps: number
}

const isCurrent = (state: unknown) => typeof state === 'object' && state !== null && 'memory' in state

/**
 * Moves cards to the current scheduler: each card's answers, in the order they were given, are
 * replayed through it, which sets its state and due time, and its start time when it had none.
 * Practice answers are left out, as they never moved the schedule. A card with no answers starts
 * over from the initial state and keeps its due time. Levels are kept, because the recall check
 * sets a card's starting level and the log doesn't hold it. Log rows are never changed.
 *
 * Deterministic, so running it twice gives the same result. With `onlyOld`, only cards still in
 * an older state's shape are replayed, which the server does on start; with `userId`, only one
 * member's cards.
 */
export async function replaySchedules({ onlyOld = false, userId, now = new Date() }: { onlyOld?: boolean; userId?: string; now?: Date } = {}): Promise<ReplayReport> {
	const all = await ownerDb
		.select({ id: cards.id, state: cards.state, dueAt: cards.dueAt, startedAt: cards.startedAt, deletedAt: cards.deletedAt })
		.from(cards)
		.where(userId ? eq(cards.userId, userId) : undefined)
	const todo = onlyOld ? all.filter((c) => !isCurrent(c.state)) : all
	const report: ReplayReport = { cards: todo.length, replayed: 0, graduated: 0, graduatedWithMemory: 0, dueBefore: 0, dueAfter: 0, dueAtChangedInSteps: 0 }
	const isDue = (c: { dueAt: Date; startedAt: Date | null; deletedAt: Date | null }) => Boolean(c.startedAt) && !c.deletedAt && c.dueAt <= now

	for (let i = 0; i < todo.length; i += 200) {
		const batch = todo.slice(i, i + 200)
		const log = await ownerDb
			.select({ cardId: reviewLog.cardId, rating: reviewLog.rating, correct: reviewLog.correct, at: reviewLog.reviewedAt, mode: reviewLog.mode })
			.from(reviewLog)
			.where(
				and(
					inArray(
						reviewLog.cardId,
						batch.map((c) => c.id),
					),
					ne(reviewLog.mode, 'practice'),
				),
			)
			.orderBy(asc(reviewLog.reviewedAt), asc(reviewLog.id))
		await ownerDb.transaction(async (tx) => {
			for (const card of batch) {
				const answers = log.filter((l) => l.cardId === card.id).map((l) => ({ ...l, mode: l.mode === 'recall' ? ('recall' as const) : ('review' as const) }))
				const out = replaySchedule(answers, defaultScheduler)
				const state: SchedulerState = out?.state ?? defaultScheduler.initial()
				const after = { dueAt: out?.dueAt ?? card.dueAt, startedAt: card.startedAt ?? answers[0]?.at ?? null, deletedAt: card.deletedAt }
				if (out) report.replayed++
				if (after.startedAt && state.step === null) {
					report.graduated++
					if (state.memory) report.graduatedWithMemory++
				}
				const before = isDue(card)
				if (before) report.dueBefore++
				if (isDue(after)) report.dueAfter++
				if (out && state.step !== null && after.dueAt.getTime() !== card.dueAt.getTime()) report.dueAtChangedInSteps++
				await tx
					.update(cards)
					.set({ state, dueAt: after.dueAt, startedAt: after.startedAt })
					.where(eq(cards.id, card.id))
			}
		})
	}
	return report
}

/** True when some card is still in an older scheduler's state, which the server replays on start. */
export const hasOldStates = async () =>
	(await ownerDb.select({ n: sql<number>`count(*)::int` }).from(cards).where(sql`not (${cards.state} ? 'memory')`))[0]!.n > 0
