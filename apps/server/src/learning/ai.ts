import { type ChatRequest, makeProviders } from '@life-log-club/llm'
import { decrypt } from '../crypto'
import { asUser } from '../db/client'
import { aiCalls, aiKeys } from '../db/schema'
import { env } from '../env'

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
