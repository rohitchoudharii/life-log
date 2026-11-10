import { type ChatRequest, estimateCost, makeProviders } from '@life-log-club/llm'
import { gte, sql } from 'drizzle-orm'
import { decrypt } from '../crypto'
import { asUser, type Tx } from '../db/client'
import { aiCalls, aiKeys } from '../db/schema'
import { env } from '../env'
import { preferencesOf } from './preferences'

export const providers = makeProviders({ anthropic: env.ANTHROPIC_BASE_URL, openai: env.OPENAI_BASE_URL })

export const keyContext = (userId: string) => `ai_keys.key:${userId}`

/**
 * Calls the member's own AI provider with the model they saved, and records the call in
 * `ai_calls`, failed or not. Returns null when the member has no key. A provider failure is
 * recorded, then thrown.
 */
export async function callAi(userId: string, purpose: string, request: (model: string) => ChatRequest): Promise<string | null> {
	const [key] = await asUser(userId, (tx) => tx.select().from(aiKeys))
	if (!key) return null
	const req = request(key.model)
	const started = Date.now()
	const record = (row: { ok: boolean; error?: string; inputTokens?: number | null; outputTokens?: number | null }) =>
		asUser(userId, (tx) => tx.insert(aiCalls).values({ userId, purpose, model: key.model, ms: Date.now() - started, ...row }))
	try {
		const reply = await providers[key.provider].complete(decrypt(key.keyCt, keyContext(userId)), req)
		await record({ ok: true, ...reply.usage })
		return reply.text
	} catch (error) {
		await record({ ok: false, error: error instanceof Error ? error.message.slice(0, 500) : String(error) })
		throw error
	}
}

/** The start of the calendar month `now` is in, in UTC, which is when the budget starts over. */
export const monthStart = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))

/**
 * This month's AI calls and their estimated cost, against the member's budget. Calls to a model
 * with no known price count in `calls` and `tokens` but not in `costUsd`, which is null when no
 * call has a price at all.
 */
export async function monthUsage(tx: Tx, userId: string, now = new Date()) {
	const rows = await tx
		.select({
			model: aiCalls.model,
			calls: sql<number>`count(*)::int`,
			input: sql<number>`coalesce(sum(${aiCalls.inputTokens}), 0)::int`,
			output: sql<number>`coalesce(sum(${aiCalls.outputTokens}), 0)::int`,
		})
		.from(aiCalls)
		.where(gte(aiCalls.at, monthStart(now)))
		.groupBy(aiCalls.model)
	const costs = rows.map((r) => estimateCost(r.model, r.input, r.output)).filter((c) => c !== null)
	const costUsd = costs.length ? costs.reduce((a, b) => a + b, 0) : null
	const { aiMonthlyBudgetUsd: budgetUsd } = await preferencesOf(tx, userId)
	return {
		calls: rows.reduce((n, r) => n + r.calls, 0),
		tokens: rows.reduce((n, r) => n + r.input + r.output, 0),
		costUsd,
		budgetUsd,
		reached: (costUsd ?? 0) >= budgetUsd,
	}
}

/** AI calls and tokens in each of the last 12 calendar months (UTC) that had any, newest first. */
export async function usageHistory(tx: Tx, now = new Date()) {
	const month = sql<string>`date_trunc('month', ${aiCalls.at} at time zone 'UTC')`
	const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1))
	const rows = await tx
		.select({
			month,
			calls: sql<number>`count(*)::int`,
			tokens: sql<number>`(coalesce(sum(${aiCalls.inputTokens}), 0) + coalesce(sum(${aiCalls.outputTokens}), 0))::int`,
		})
		.from(aiCalls)
		.where(gte(aiCalls.at, since))
		.groupBy(month)
		.orderBy(sql`1 desc`)
	return rows.map((r) => ({ month: new Date(`${String(r.month).slice(0, 10)}T00:00:00Z`), calls: r.calls, tokens: r.tokens }))
}

/**
 * The one check background AI work makes before it spends: false once this month's estimated
 * spend has reached the member's budget. Work the member is waiting on, such as grading, doesn't
 * ask.
 */
export const withinBudget = (userId: string, now = new Date()) => asUser(userId, async (tx) => !(await monthUsage(tx, userId, now)).reached)
