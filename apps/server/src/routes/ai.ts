import { LlmError, makeProviders, type ProviderId } from '@life-log-club/llm'
import { ORPCError } from '@orpc/server'
import { eq } from 'drizzle-orm'
import { encrypt } from '../crypto'
import { asUser } from '../db/client'
import { aiKeys } from '../db/schema'
import { env } from '../env'
import { authed } from '../orpc'

const providers = makeProviders({ anthropic: env.ANTHROPIC_BASE_URL, openai: env.OPENAI_BASE_URL })

/** Proves the key works by listing its models, which costs nothing, and picks a low-cost one. */
async function chooseModel(provider: ProviderId, apiKey: string) {
	try {
		const models = await providers[provider].listModels(apiKey)
		const model = providers[provider].suggestModel(models)
		if (!model) throw new ORPCError('BAD_REQUEST', { message: 'This key has no chat models available.' })
		return model
	} catch (error) {
		if (!(error instanceof LlmError)) throw error
		throw new ORPCError('BAD_REQUEST', {
			message:
				error.status === 401
					? 'The provider rejected this key. Check that you copied all of it.'
					: /not scoped to a workspace/.test(error.message)
						? 'This Anthropic key is not tied to a workspace. Create a new key and choose one workspace, such as Default.'
						: `The provider answered: ${error.message}`,
		})
	}
}

export const keyContext = (userId: string) => `ai_keys.key:${userId}`

export const aiRoutes = {
	getKey: authed.ai.getKey.handler(({ context }) =>
		asUser(context.user.id, async (tx) => {
			const [row] = await tx
				.select({ provider: aiKeys.provider, model: aiKeys.model, last4: aiKeys.last4 })
				.from(aiKeys)
			return row ?? null
		}),
	),

	saveKey: authed.ai.saveKey.handler(async ({ input, context }) => {
		const model = await chooseModel(input.provider, input.apiKey)
		const row = {
			provider: input.provider,
			model,
			keyCt: encrypt(input.apiKey, keyContext(context.user.id)),
			last4: input.apiKey.slice(-4),
			updatedAt: new Date(),
		}
		await asUser(context.user.id, (tx) =>
			tx
				.insert(aiKeys)
				.values({ userId: context.user.id, ...row })
				.onConflictDoUpdate({ target: aiKeys.userId, set: row }),
		)
		return { provider: row.provider, model, last4: row.last4 }
	}),

	removeKey: authed.ai.removeKey.handler(async ({ context }) => {
		await asUser(context.user.id, (tx) => tx.delete(aiKeys).where(eq(aiKeys.userId, context.user.id)))
		return { ok: true as const }
	}),
}
