export type ProviderId = 'anthropic' | 'openai'

export type ChatRequest = { model: string; system: string; user: string; json?: boolean; maxTokens?: number; timeoutMs?: number }

/** A model's reply and the tokens it used, for the member's usage record. */
export type ChatReply = { text: string; usage: { inputTokens: number | null; outputTokens: number | null } }

export type LlmProvider = {
	id: ProviderId
	/** Lists models the key can use. Also proves the key works without spending tokens. */
	listModels(apiKey: string): Promise<string[]>
	/** Picks a sensible low-cost default from the models the key can use. */
	suggestModel(models: string[]): string | undefined
	complete(apiKey: string, req: ChatRequest): Promise<ChatReply>
}

export class LlmError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message)
	}
}

async function call(url: string, init: RequestInit, timeoutMs = 120_000): Promise<any> {
	const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
	const body: any = await res.json().catch(() => ({}))
	if (!res.ok) throw new LlmError(body?.error?.message ?? `Provider returned ${res.status}`, res.status)
	return body
}

const anthropic = (base: string): LlmProvider => ({
	id: 'anthropic',
	async listModels(apiKey) {
		const body = await call(`${base}/v1/models?limit=100`, {
			headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
		})
		return (body.data as { id: string }[]).map((m) => m.id)
	},
	// The API lists newest models first.
	suggestModel: (models) => models.find((m) => m.includes('haiku')) ?? models.find((m) => m.includes('sonnet')) ?? models[0],
	async complete(apiKey, req) {
		const body = await call(`${base}/v1/messages`, {
			method: 'POST',
			headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
			body: JSON.stringify({
				model: req.model,
				max_tokens: req.maxTokens ?? 4096,
				system: req.system,
				messages: [{ role: 'user', content: req.user }],
			}),
		}, req.timeoutMs)
		return {
			text: (body.content as { type: string; text?: string }[])
				.filter((b) => b.type === 'text')
				.map((b) => b.text)
				.join(''),
			usage: { inputTokens: body.usage?.input_tokens ?? null, outputTokens: body.usage?.output_tokens ?? null },
		}
	},
})

const NON_CHAT = /audio|realtime|tts|transcribe|image|embedding|moderation|search|dall-e|whisper|babbage|davinci|instruct/

const openai = (base: string): LlmProvider => ({
	id: 'openai',
	async listModels(apiKey) {
		const body = await call(`${base}/v1/models`, { headers: { authorization: `Bearer ${apiKey}` } })
		return (body.data as { id: string; created: number }[])
			.filter((m) => /^(gpt-|o\d|chatgpt-)/.test(m.id) && !NON_CHAT.test(m.id))
			.sort((a, b) => b.created - a.created)
			.map((m) => m.id)
	},
	suggestModel: (models) => models.find((m) => /mini|luna|terra/.test(m)) ?? models[0],
	async complete(apiKey, req) {
		const body = await call(`${base}/v1/chat/completions`, {
			method: 'POST',
			headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
			body: JSON.stringify({
				model: req.model,
				messages: [
					{ role: 'system', content: req.system },
					{ role: 'user', content: req.user },
				],
				...(req.json ? { response_format: { type: 'json_object' } } : {}),
			}),
		}, req.timeoutMs)
		return {
			text: body.choices?.[0]?.message?.content ?? '',
			usage: { inputTokens: body.usage?.prompt_tokens ?? null, outputTokens: body.usage?.completion_tokens ?? null },
		}
	},
})

export const PROVIDER_IDS = ['anthropic', 'openai'] as const satisfies ProviderId[]

export const DEFAULT_BASE_URLS: Record<ProviderId, string> = {
	anthropic: 'https://api.anthropic.com',
	openai: 'https://api.openai.com',
}

/** The providers, talking to the given API addresses (tests point them at a local fake). */
export function makeProviders(baseUrls: Record<ProviderId, string> = DEFAULT_BASE_URLS): Record<ProviderId, LlmProvider> {
	return { anthropic: anthropic(baseUrls.anthropic), openai: openai(baseUrls.openai) }
}
