import { randomUUID } from 'node:crypto'
import { defaultScheduler } from '@life-log-club/domain'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { asUser, ownerDb, ownerPool, pool } from '../db/client'
import { prepareDatabase } from '../db/prepare'
import { aiCalls, cards, entries, preferences, questions, readings, recallAttempts, reviewLog, sections, users } from '../db/schema'

beforeAll(prepareDatabase)
afterAll(() => Promise.all([pool.end(), ownerPool.end()]))

async function member() {
	const [user] = await ownerDb
		.insert(users)
		.values({ email: `rls-${randomUUID()}@example.com`, name: 'M' })
		.returning()
	return user!.id
}

/** A ready reading with one section, one key idea card, one question on it and one answer. */
async function readingWithIdea(userId: string) {
	const readingId = randomUUID()
	const cardId = randomUUID()
	return asUser(userId, async (tx) => {
		await tx.insert(readings).values({ id: readingId, userId, title: 'Memory', source: 'url', status: 'ready' })
		const [section] = await tx
			.insert(sections)
			.values({ userId, readingId, position: 0, level: 1, title: 'Spacing', blocks: [], wordCount: 300 })
			.returning()
		await tx.insert(cards).values({
			id: cardId,
			userId,
			kind: 'idea',
			origin: 'ai',
			readingId,
			sectionId: section!.id,
			position: 0,
			prompt: 'Why do gaps between reviews help?',
			answer: 'Recall after a gap is harder, and the effort makes the memory last.',
			quote: 'The effort of recall after a gap is what makes it last.',
			state: defaultScheduler.initial(),
		})
		const [question] = await tx
			.insert(questions)
			.values({
				userId,
				cardId,
				readingId,
				sectionId: section!.id,
				type: 'short_answer',
				level: 'explain',
				content: { prompt: 'Why does a gap help?', reference: 'Harder recall lasts longer.' },
			})
			.returning()
		await tx.insert(reviewLog).values({
			userId,
			cardId,
			answerId: randomUUID(),
			questionId: question!.id,
			ask: 'question',
			mode: 'recall',
			rating: 'good',
			correct: true,
			gradedBy: 'ai',
			nextDueAt: new Date(),
		})
		return { readingId, cardId, questionId: question!.id }
	})
}

it("keeps a member's key ideas, questions and answers from every other member", async () => {
	const [a, b] = [await member(), await member()]
	const mine = await readingWithIdea(a)

	const seen = (userId: string) =>
		asUser(userId, async (tx) => ({
			cards: await tx.select().from(cards),
			questions: await tx.select().from(questions),
			log: await tx.select().from(reviewLog),
		}))
	const own = await seen(a)
	expect(own.cards.map((c) => c.id)).toEqual([mine.cardId])
	expect(own.cards[0]).toMatchObject({ origin: 'ai', level: 0, startedAt: null, deletedAt: null })
	expect(own.questions.map((q) => q.id)).toEqual([mine.questionId])
	expect(own.log).toHaveLength(1)
	expect(await seen(b)).toEqual({ cards: [], questions: [], log: [] })

	// Row-level security also refuses a row written for another member.
	await expect(
		asUser(b, (tx) =>
			tx.insert(questions).values({ userId: a, cardId: mine.cardId, type: 'short_answer', level: 'explain', content: {} }),
		),
	).rejects.toThrow()
})

/** Tables the auth module reads across members on purpose; nothing else may skip row-level security. */
const AUTH_TABLES = ['users', 'invites', 'sessions', 'audit_log']

it('every other table has row-level security that limits reads and writes to the member’s own rows', async () => {
	const { rows } = await ownerPool.query<{ name: string; rls: boolean; policies: { cmd: string; using: string | null; check: string | null }[] }>(
		`select c.relname as name, c.relrowsecurity as rls,
			coalesce(json_agg(json_build_object('cmd', p.polcmd, 'using', pg_get_expr(p.polqual, p.polrelid), 'check', pg_get_expr(p.polwithcheck, p.polrelid)))
				filter (where p.polname is not null), '[]') as policies
		from pg_class c join pg_namespace n on n.oid = c.relnamespace left join pg_policy p on p.polrelid = c.oid
		where n.nspname = 'public' and c.relkind = 'r'
		group by c.relname, c.relrowsecurity order by c.relname`,
	)
	const member = rows.filter((r) => !AUTH_TABLES.includes(r.name))
	expect(member.map((r) => r.name)).toEqual(expect.arrayContaining(['readings', 'sections', 'cards', 'questions', 'recall_attempts', 'ai_calls', 'review_log']))
	const own = (expr: string | null) => /^\(user_id = \(NULLIF\(current_setting\('app\.user_id'::text, true\), ''::text\)\)::uuid\)$/.test(expr ?? '')
	const unsafe = member.filter((r) => !r.rls || !r.policies.some((p) => p.cmd === '*' && own(p.using) && own(p.check)))
	expect(unsafe.map((r) => r.name)).toEqual([])
})

it("a member sees no row of another member's readings, sections, cards, questions, answers, recall attempts or AI calls", async () => {
	const [a, b] = [await member(), await member()]
	const mine = await readingWithIdea(a)
	await asUser(a, async (tx) => {
		const [section] = await tx.select({ id: sections.id }).from(sections).where(eq(sections.readingId, mine.readingId))
		await tx.insert(recallAttempts).values({ id: randomUUID(), userId: a, readingId: mine.readingId, sectionIds: [section!.id] })
		await tx.insert(aiCalls).values({ userId: a, purpose: 'write-section', model: 'claude-haiku-5-5', ms: 900, ok: true })
		await tx.insert(preferences).values({ userId: a })
		await tx.insert(entries).values({ id: randomUUID(), userId: a, type: 'lesson', pillar: 'mind', occurredAt: new Date(), details: {}, text: 'A only' })
	})
	const { rows } = await ownerPool.query<{ name: string }>(
		`select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
		where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity order by c.relname`,
	)
	// Counted as each member, across every table with row-level security: A sees their rows, B none of anyone's.
	const counts = (userId: string) =>
		asUser(userId, async (tx) =>
			Object.fromEntries(
				await Promise.all(rows.map(async ({ name }) => [name, Number((await tx.execute(sql`select count(*) as n from ${sql.identifier(name)}`)).rows[0]!.n)])),
			),
		)
	const seenByA = await counts(a)
	for (const table of ['readings', 'sections', 'cards', 'questions', 'review_log', 'recall_attempts', 'ai_calls', 'preferences', 'entries']) expect(seenByA[table], table).toBe(1)
	expect(Object.values(await counts(b)).every((n) => n === 0)).toBe(true)
})
