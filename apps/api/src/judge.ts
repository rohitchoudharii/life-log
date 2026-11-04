import type { Judge } from '@peak/core'
import { judgeAnswer, LlmError, providers } from '@peak/llm'
import { eq } from 'drizzle-orm'
import { HTTPException } from 'hono/http-exception'
import { decryptSecret } from './crypto'
import { db, t } from './db'

/** A judge that grades with the user's own key. The key is loaded only when an answer needs it. */
export function judgeFor(userId: string): Judge {
	return async (input) => {
		const [key] = await db.select().from(t.llmKeys).where(eq(t.llmKeys.userId, userId))
		if (!key) throw new HTTPException(400, { message: 'Connect your AI in Settings so it can check written answers.' })
		try {
			return await judgeAnswer(providers[key.provider], decryptSecret(key.encryptedKey), key.model, input)
		} catch (err) {
			const reason = err instanceof LlmError ? err.message : 'it returned something unreadable'
			throw new HTTPException(502, { message: `Your AI could not check this answer: ${reason}. Try again.` })
		}
	}
}
