import type { Word } from '@life-log-club/contract'
import { defaultScheduler, formIn, wordTestFor } from '@life-log-club/domain'
import { defineWordRequest, parseDefinition } from '@life-log-club/llm'
import { ORPCError } from '@orpc/server'
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm'
import { asUser, type Tx } from '../db/client'
import { aiKeys, cards, readings, sections } from '../db/schema'
import { callAi, withinBudget } from './ai'

const DAY = 24 * 60 * 60 * 1000
/** How long a word without a meaning shows as being defined, before it asks the member for one. */
const DEFINING_MS = 5 * 60 * 1000

type WordDetails = { word: string; form: string; sentence: string | null }
type CardRow = typeof cards.$inferSelect

const squash = (text: string) => text.replace(/\s+/g, ' ').trim()
const cueOf = (word: string) => `What does “${word}” mean?`
const notFound = () => new ORPCError('NOT_FOUND', { message: 'That word is not in your vocabulary. It may have been removed.' })

/** The word as the API shows it. */
export function toWord(card: CardRow, readingTitle: string | null, now = new Date()): Word {
	const d = card.details as WordDetails
	const meaning = card.answer || null
	return {
		id: card.id,
		word: d.word,
		form: d.form,
		sentence: d.sentence,
		meaning,
		defining: !meaning && now.getTime() - card.createdAt.getTime() < DEFINING_MS,
		test: wordTestFor(card.level, Boolean(d.sentence)),
		readingId: card.readingId,
		sectionId: card.sectionId,
		readingTitle,
		dueAt: card.dueAt,
		createdAt: card.createdAt,
	}
}

const isWord = (id: string) => and(eq(cards.id, id), eq(cards.kind, 'word'))
/** A word card matching `word` by its dictionary form or the form the member met. */
const sameWord = (word: string) =>
	and(eq(cards.kind, 'word'), or(sql`lower(${cards.details}->>'word') = ${word.toLowerCase()}`, sql`lower(${cards.details}->>'form') = ${word.toLowerCase()}`))

async function withTitle(tx: Tx, card: CardRow) {
	if (!card.readingId) return toWord(card, null)
	const [r] = await tx.select({ title: readings.title }).from(readings).where(eq(readings.id, card.readingId))
	return toWord(card, r?.title ?? null)
}

export type AddWord = { id: string; form: string; sentence?: string; meaning?: string; sectionId?: string }

/**
 * Adds a word to the member's vocabulary as a card, started at step 1 and due in a day, like a
 * saved idea. A word met while reading keeps its sentence and section. Without a meaning the AI
 * defines it later, so it needs a key. A word already there (by either form) is returned as it is,
 * with its first sentence; a removed one comes back. Returns the word, whether it was there, and
 * whether it needs defining.
 */
export async function addWord(userId: string, input: AddWord) {
	return asUser(userId, async (tx) => {
		// Foreign keys skip row-level security, so the section is looked up here, where only the member's own are found.
		let readingId: string | null = null
		if (input.sectionId) {
			const [place] = await tx
				.select({ readingId: sections.readingId })
				.from(sections)
				.innerJoin(readings, eq(readings.id, sections.readingId))
				.where(and(eq(sections.id, input.sectionId), isNull(readings.deletedAt)))
			if (!place) throw new ORPCError('NOT_FOUND', { message: 'That reading does not exist. It may have been removed.' })
			readingId = place.readingId
		}
		const sentence = input.sentence ? squash(input.sentence) : null
		const form = sentence ? formIn(sentence, input.form) : input.form
		if (!form) throw new ORPCError('BAD_REQUEST', { message: 'The sentence must use the word.' })

		const [existing] = await tx.select().from(cards).where(sameWord(input.form))
		if (existing) {
			const card = existing.deletedAt ? (await tx.update(cards).set({ deletedAt: null }).where(eq(cards.id, existing.id)).returning())[0]! : existing
			return { word: await withTitle(tx, card), existing: true, needsDefining: false }
		}

		const meaning = input.meaning || null
		const hasKey = (await tx.select({ id: aiKeys.userId }).from(aiKeys)).length > 0
		if (!meaning && !hasKey) throw new ORPCError('BAD_REQUEST', { message: 'Add what it means.' })
		const word = (sentence ? form : input.form).toLowerCase()
		const now = new Date()
		const [created] = await tx
			.insert(cards)
			.values({
				id: input.id,
				userId,
				kind: 'word',
				origin: 'member',
				readingId,
				sectionId: input.sectionId ?? null,
				quote: sentence,
				details: { word, form, sentence } satisfies WordDetails,
				prompt: cueOf(word),
				answer: meaning ?? '',
				// Adding a word is a study event, so it comes back tomorrow.
				state: { ...defaultScheduler.initial(), step: 1 },
				startedAt: now,
				dueAt: new Date(now.getTime() + DAY),
			})
			.onConflictDoNothing()
			.returning()
		if (created) return { word: await withTitle(tx, created), existing: false, needsDefining: !meaning }
		// A retry of the same add, or the same word added at the same moment.
		const [again] = await tx.select().from(cards).where(or(eq(cards.id, input.id), sameWord(input.form)))
		if (!again || again.kind !== 'word') throw new ORPCError('CONFLICT', { message: 'That card id is taken. Try again.' })
		return { word: await withTitle(tx, again), existing: again.id !== input.id, needsDefining: false }
	})
}

/** The member's words, newest first, with the reading each came from. */
export function listWords(userId: string) {
	return asUser(userId, async (tx) => {
		const rows = await tx
			.select({ card: cards, title: readings.title })
			.from(cards)
			.leftJoin(readings, eq(readings.id, cards.readingId))
			.where(and(eq(cards.kind, 'word'), isNull(cards.deletedAt)))
			.orderBy(desc(cards.createdAt))
		const now = new Date()
		return rows.map((r) => toWord(r.card, r.title, now))
	})
}

/** The words the AI found in a section that the member has not kept, by either form. */
export function suggestions(userId: string, sectionId: string) {
	return asUser(userId, async (tx) => {
		const [section] = await tx
			.select({ terms: sections.terms })
			.from(sections)
			.innerJoin(readings, eq(readings.id, sections.readingId))
			.where(and(eq(sections.id, sectionId), isNull(readings.deletedAt)))
		if (!section) throw new ORPCError('NOT_FOUND', { message: 'That section does not exist. It may have been removed.' })
		const kept = await tx.select({ details: cards.details }).from(cards).where(and(eq(cards.kind, 'word'), isNull(cards.deletedAt)))
		const known = new Set(kept.flatMap((c) => [(c.details as WordDetails).word, (c.details as WordDetails).form].map((w) => w.toLowerCase())))
		return section.terms.filter((t) => !known.has(t.word.toLowerCase()) && !known.has(t.form.toLowerCase()))
	})
}

export function setMeaning(userId: string, id: string, meaning: string) {
	return asUser(userId, async (tx) => {
		const [card] = await tx
			.update(cards)
			.set({ answer: meaning })
			.where(and(isWord(id), isNull(cards.deletedAt)))
			.returning()
		if (!card) throw notFound()
		return withTitle(tx, card)
	})
}

export function removeWord(userId: string, id: string) {
	return asUser(userId, async (tx) => {
		const [card] = await tx
			.update(cards)
			.set({ deletedAt: new Date() })
			.where(and(isWord(id), isNull(cards.deletedAt)))
			.returning({ id: cards.id })
		if (!card) throw notFound()
		return { ok: true as const }
	})
}

export function restoreWord(userId: string, id: string) {
	return asUser(userId, async (tx) => {
		const [card] = await tx.update(cards).set({ deletedAt: null }).where(isWord(id)).returning()
		if (!card) throw notFound()
		return withTitle(tx, card)
	})
}

export type DefineWordJob = { userId: string; cardId: string }

/**
 * The `define-word` job: asks the member's AI what a word they added means in its sentence (or
 * for an example sentence when they typed none) and its dictionary form. Background work, so it
 * stops at the budget; the word then asks the member for its meaning. A meaning the member typed
 * meanwhile is kept. The dictionary form is used only when no other word card has it.
 */
export async function defineWord({ userId, cardId }: DefineWordJob) {
	if (!(await withinBudget(userId))) return
	const [card] = await asUser(userId, (tx) =>
		tx
			.select()
			.from(cards)
			.where(and(isWord(cardId), isNull(cards.deletedAt))),
	)
	if (!card || card.answer) return
	const d = card.details as WordDetails
	const reply = await callAi(userId, 'define-word', (model) => defineWordRequest(model, { form: d.form, sentence: d.sentence }))
	const term = reply && parseDefinition(reply, { form: d.form, sentence: d.sentence })
	if (!term) return
	const set = (word: string) =>
		asUser(userId, (tx) =>
			tx
				.update(cards)
				.set({ answer: term.meaning, prompt: cueOf(word), details: { ...d, word, sentence: d.sentence ?? (term.sentence || null) } })
				.where(and(eq(cards.id, card.id), eq(cards.answer, ''))),
		)
	try {
		await set(term.word.toLowerCase())
	} catch (error) {
		// Another card already has that dictionary form: keep the form the member added.
		if ((error as { cause?: { code?: string } }).cause?.code !== '23505' && (error as { code?: string }).code !== '23505') throw error
		await set(d.word)
	}
}
