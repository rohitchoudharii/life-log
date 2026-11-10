import { FSRS_DEFAULT_WEIGHTS, FSRS_MODEL, type Rating, stepsThenFsrs } from '@life-log-club/domain'
import { computeParameters, FSRSBindingItem, FSRSBindingReview } from '@open-spaced-repetition/binding'
import { asc, desc, inArray, sql } from 'drizzle-orm'
import { asUser, ownerDb } from '../db/client'
import { preferences, reviewLog, schedulerFits } from '../db/schema'

/** Answers in Recall and Review a member needs before their schedule is tuned to them. */
export const MIN_TUNING_REVIEWS = 1000
/** The newest share of answers kept back to check a fit on, never trained on. */
const HELD_OUT = 0.2

const DAY = 86_400_000
const GRADE: Record<Rating, number> = { again: 1, hard: 2, good: 3, easy: 4 }

/** One logged answer to a card, as tuning needs it. */
export type TuningAnswer = { cardId: string; rating: Rating; at: Date }

export type Fit = {
	reviews: number
	heldOut: number
	weights: number[]
	/** Log loss on the held-out answers; lower predicts them better. */
	currentLogLoss: number
	newLogLoss: number
	kept: boolean
}

/** Whole days between two answers, as the scheduler counts them. */
const daysBetween = (a: Date, b: Date) => Math.max(0, Math.floor((b.getTime() - a.getTime()) / DAY))

function byCard(answers: TuningAnswer[]) {
	const cards = new Map<string, TuningAnswer[]>()
	for (const a of answers) cards.set(a.cardId, [...(cards.get(a.cardId) ?? []), a])
	for (const list of cards.values()) list.sort((x, y) => x.at.getTime() - y.at.getTime())
	return [...cards.values()]
}

/** One FSRS item per answer after a card's first and before `until`: the card's answers up to it. */
function trainingItems(cards: TuningAnswer[][], until: number) {
	const items: FSRSBindingItem[] = []
	for (const list of cards) {
		const reviews = list.map((a, i) => new FSRSBindingReview(GRADE[a.rating], i === 0 ? 0 : daysBetween(list[i - 1]!.at, a.at)))
		for (let n = 2; n <= list.length && list[n - 1]!.at.getTime() < until; n++) items.push(new FSRSBindingItem(reviews.slice(0, n)))
	}
	return items
}

/**
 * How well `weights` predicted the answers from `from` on: each card's answers are replayed through
 * the app's own scheduler, and its predicted recall just before each of those answers is scored
 * against whether it was right. Mean log loss; lower is better.
 */
function heldOutLogLoss(cards: TuningAnswer[][], from: number, weights: readonly number[]) {
	const scheduler = stepsThenFsrs({ weights, fuzz: false })
	let sum = 0
	let n = 0
	for (const list of cards) {
		let state = scheduler.initial()
		for (const [i, a] of list.entries()) {
			if (i > 0 && a.at.getTime() >= from) {
				const p = Math.min(1 - 1e-6, Math.max(1e-6, scheduler.retrievability(state, a.at) ?? 0.9))
				sum -= a.rating === 'again' ? Math.log(1 - p) : Math.log(p)
				n++
			}
			state = scheduler.next(state, a.rating, a.at).state
		}
	}
	return { logLoss: n ? sum / n : 0, n }
}

const usable = (weights: number[]) => weights.length === FSRS_DEFAULT_WEIGHTS.length && weights.every(Number.isFinite)

/**
 * Fits FSRS parameters to a member's answers and checks them against the parameters in use. The
 * newest fifth of the answers that follow an earlier one is held out: the fit learns from the
 * older answers only, and both sets of parameters are scored on the held-out ones. The new ones
 * are kept only when they predict those answers better. Null below 1,000 answers.
 */
export async function fitSchedule(answers: TuningAnswer[], current: readonly number[] | null): Promise<Fit | null> {
	if (answers.length < MIN_TUNING_REVIEWS) return null
	const cards = byCard(answers)
	const later = cards.flatMap((list) => list.slice(1).map((a) => a.at.getTime())).sort((a, b) => a - b)
	const from = later[Math.floor(later.length * (1 - HELD_OUT))]!
	const train = trainingItems(cards, from)
	const inUse = current ?? FSRS_DEFAULT_WEIGHTS
	const held = heldOutLogLoss(cards, from, inUse)
	const weights = await computeParameters(train, { modelVersion: FSRS_MODEL, enableShortTerm: false })
	const newLogLoss = usable(weights) ? heldOutLogLoss(cards, from, weights).logLoss : held.logLoss
	const kept = usable(weights) && newLogLoss < held.logLoss
	return { reviews: train.length, heldOut: held.n, weights: kept ? weights : [...inUse], currentLogLoss: held.logLoss, newLogLoss, kept }
}

/**
 * The monthly tuning of one member's schedule. Every try is logged; new parameters are used from
 * the next answer on only when they fit the held-out answers better. Cards already scheduled keep
 * their due times.
 */
export async function tuneMember(userId: string) {
	const { answers, current } = await asUser(userId, async (tx) => {
		const answers = await tx
			.select({ cardId: reviewLog.cardId, rating: reviewLog.rating, at: reviewLog.reviewedAt })
			.from(reviewLog)
			.where(inArray(reviewLog.mode, ['recall', 'review']))
			.orderBy(asc(reviewLog.reviewedAt))
		const [prefs] = await tx.select({ weights: preferences.fsrsWeights }).from(preferences)
		return { answers, current: prefs?.weights ?? null }
	})
	const fit = await fitSchedule(answers, current)
	if (!fit) return null
	await asUser(userId, async (tx) => {
		await tx.insert(schedulerFits).values({ userId, ...fit })
		if (fit.kept)
			await tx
				.insert(preferences)
				.values({ userId, fsrsWeights: fit.weights })
				.onConflictDoUpdate({ target: preferences.userId, set: { fsrsWeights: fit.weights, updatedAt: new Date() } })
	})
	return fit
}

/** Members with enough answers to tune, across all members, for the monthly job. */
export async function membersToTune() {
	const rows = await ownerDb
		.select({ userId: reviewLog.userId })
		.from(reviewLog)
		.where(inArray(reviewLog.mode, ['recall', 'review']))
		.groupBy(reviewLog.userId)
		.having(sql`count(*) >= ${MIN_TUNING_REVIEWS}`)
	return rows.map((r) => r.userId)
}

/** Where the member's tuning stands, for Settings: answers so far, whether their own parameters are in use, and the last try. */
export function tuningOf(userId: string) {
	return asUser(userId, async (tx) => {
		const [count] = await tx
			.select({ n: sql<number>`count(*)::int` })
			.from(reviewLog)
			.where(inArray(reviewLog.mode, ['recall', 'review']))
		const [prefs] = await tx.select({ weights: preferences.fsrsWeights }).from(preferences)
		const [last] = await tx.select().from(schedulerFits).orderBy(desc(schedulerFits.at)).limit(1)
		return {
			reviews: count?.n ?? 0,
			needed: MIN_TUNING_REVIEWS,
			tuned: Boolean(prefs?.weights),
			last: last ? { at: last.at, kept: last.kept, improvement: last.kept ? 1 - last.newLogLoss / last.currentLogLoss : 0 } : null,
		}
	})
}
