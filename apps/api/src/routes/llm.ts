import { isProviderId, LlmError, providers, PROVIDER_IDS, type ProviderId } from '@life-log-club/llm'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import { encryptSecret } from '../crypto'
import { db, t } from '../db'
import { parseBody, requireUser, type AppEnv } from '../http'
import { requeueWaitingItems } from '../jobs'

const KeyInput = z.object({
	provider: z.string().refine(isProviderId, 'Choose Anthropic or OpenAI') as z.ZodType<ProviderId>,
	apiKey: z.string().trim().min(10, 'Paste the whole key'),
})

async function checkKey(provider: ProviderId, apiKey: string) {
	try {
		const models = await providers[provider].listModels(apiKey)
		if (!models.length) throw new HTTPException(400, { message: 'This key has no chat models available.' })
		return { models, suggested: providers[provider].suggestModel(models)! }
	} catch (err) {
		if (err instanceof LlmError)
			throw new HTTPException(400, {
				message:
					err.status === 401
						? 'The provider rejected this key. Check that you copied all of it.'
						: /not scoped to a workspace/.test(err.message)
							? 'This Anthropic key is not tied to a workspace. Create a new key and choose one workspace, such as Default, in the create dialog.'
							: err.message,
			})
		throw err
	}
}

export const llm = new Hono<AppEnv>()
	.use(requireUser)
	.get('/', async (c) => {
		const [key] = await db
			.select({ provider: t.llmKeys.provider, model: t.llmKeys.model, last4: t.llmKeys.last4 })
			.from(t.llmKeys)
			.where(eq(t.llmKeys.userId, c.var.user.id))
		return c.json({ key: key ?? null, providers: PROVIDER_IDS })
	})
	// Checks a key and lists its models, without saving anything.
	.post('/test', async (c) => {
		const { provider, apiKey } = await parseBody(c, KeyInput)
		return c.json(await checkKey(provider, apiKey))
	})
	.put('/', async (c) => {
		const { provider, apiKey, model } = await parseBody(c, KeyInput.extend({ model: z.string().min(1) }))
		const { models } = await checkKey(provider, apiKey)
		if (!models.includes(model)) throw new HTTPException(400, { message: 'That model is not available for this key.' })
		const row = { provider, model, encryptedKey: encryptSecret(apiKey), last4: apiKey.slice(-4) }
		await db
			.insert(t.llmKeys)
			.values({ userId: c.var.user.id, ...row })
			.onConflictDoUpdate({ target: t.llmKeys.userId, set: row })
		await requeueWaitingItems(c.var.user.id)
		return c.json({ key: { provider, model, last4: row.last4 } })
	})
	.delete('/', async (c) => {
		await db.delete(t.llmKeys).where(eq(t.llmKeys.userId, c.var.user.id))
		return c.json({ ok: true })
	})
