import type { Judge } from '@life-log-club/core'
import { judgeAnswer, LlmError, providers, type LlmProvider } from '@life-log-club/llm'
import { eq } from 'drizzle-orm'
import { HTTPException } from 'hono/http-exception'
import { decryptSecret } from './crypto'
import { db, t } from './db'

export type UserAi = { provider: LlmProvider; apiKey: string; model: string }

/** The user's own AI connection, or a 400 telling them to connect one. */
export async function userAi(userId: string, needed = 'check written answers'): Promise<UserAi> {
	const [key] = await db.select().from(t.llmKeys).where(eq(t.llmKeys.userId, userId))
	if (!key) throw new HTTPException(400, { message: `Connect your AI in Settings so it can ${needed}.` })
	return { provider: providers[key.provider], apiKey: decryptSecret(key.encryptedKey), model: key.model }
}

/** Turns a provider failure into a message the learner can act on. */
export function aiFailure(err: unknown, what: string): HTTPException {
	if (err instanceof HTTPException) return err
	const reason = err instanceof LlmError ? err.message : 'it returned something unreadable'
	return new HTTPException(502, { message: `Your AI could not ${what}: ${reason}. Try again.` })
}

/** A judge that grades with the user's own key. The key is loaded only when an answer needs it. */
export function judgeFor(userId: string): Judge {
	return async (input) => {
		const ai = await userAi(userId)
		try {
			return await judgeAnswer(ai.provider, ai.apiKey, ai.model, input)
		} catch (err) {
			throw aiFailure(err, 'check this answer')
		}
	}
}
