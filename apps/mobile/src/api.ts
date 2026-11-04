import type { Block, PointStatus, QuestionIntensity, QuestionPrompt, QuestionStyle, Rating } from '@peak/core'
import Constants from 'expo-constants'
import * as SecureStore from 'expo-secure-store'
import { Platform } from 'react-native'

// In development a phone reaches the API on the same machine that serves the app bundle.
const devHost = Constants.expoConfig?.hostUri?.split(':')[0]
const BASE =
	process.env.EXPO_PUBLIC_API_URL ??
	(Platform.OS !== 'web' && devHost ? `http://${devHost}:8787` : 'http://localhost:8787')
const TOKEN_KEY = 'peak.session'

// Native keeps the session in the Keychain or Keystore; web has only localStorage.
export const tokenStore = {
	get: () => (Platform.OS === 'web' ? Promise.resolve(localStorage.getItem(TOKEN_KEY)) : SecureStore.getItemAsync(TOKEN_KEY)),
	set: (v: string) => (Platform.OS === 'web' ? Promise.resolve(localStorage.setItem(TOKEN_KEY, v)) : SecureStore.setItemAsync(TOKEN_KEY, v)),
	clear: () => (Platform.OS === 'web' ? Promise.resolve(localStorage.removeItem(TOKEN_KEY)) : SecureStore.deleteItemAsync(TOKEN_KEY)),
}

export class ApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message)
	}
}

let token: string | null = null
let onUnauthorized: () => void = () => {}
export const setSession = (t: string | null, onExpired?: () => void) => {
	token = t
	if (onExpired) onUnauthorized = onExpired
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
	let res: Response
	try {
		res = await fetch(BASE + path, {
			method,
			headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
			body: body === undefined ? undefined : JSON.stringify(body),
		})
	} catch {
		throw new ApiError(`Can't reach the server at ${BASE}`, 0)
	}
	const json = await res.json().catch(() => ({}))
	if (res.status === 401 && token) onUnauthorized()
	if (!res.ok) throw new ApiError(json.error ?? `Request failed (${res.status})`, res.status)
	return json as T
}

export type ItemStatus = 'processing' | 'ready' | 'needs_key' | 'failed'
export type ItemSummary = {
	id: string
	title: string
	status: ItemStatus
	error: string | null
	sectionCount: number
	questionCount: number
	createdAt: string
}
export type Section = {
	id: string
	position: number
	/** 1 to 3; a section's subsections follow it with a deeper level. */
	level: number
	title: string
	blocks: Block[]
	wordCount: number
	questionCount: number
}
export type Item = Omit<ItemSummary, 'sectionCount' | 'questionCount'> & { questionIntensity: QuestionIntensity; questionStyle: QuestionStyle }
export type StudySession = {
	id: string
	itemId: string
	plannedMinutes: number
	startedAt: string
	endedAt: string | null
}
export type Question = QuestionPrompt & { id: string; itemTitle?: string }
export type RecallIdea = { id: string; text: string; section: string; status: PointStatus | null }
export type Recall = { id: string; text: string; feedback: string | null; gradeError: string | null; ideas: RecallIdea[] }
export type AnswerResult = { correct: boolean; rating: Rating; reveal: Record<string, unknown>; dueAt: string }
export type Today = {
	due: number
	reviewedToday: number
	dailyReviewCap: number
	streak: number
	ongoing: { id: string; title: string }[]
}
export type Me = { email: string; timezone: string; reminderTime: string | null; dailyReviewCap: number }
export type Provider = 'anthropic' | 'openai'
export type KeyInfo = { provider: Provider; model: string; last4: string }

const timezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone

export const api = {
	requestCode: (email: string) => request<{ ok: true }>('POST', '/auth/otp/request', { email }),
	verifyCode: (email: string, code: string) =>
		request<{ token: string }>('POST', '/auth/otp/verify', { email, code, timezone: timezone() }),
	logout: () => request('POST', '/auth/logout'),

	me: () => request<Me>('GET', '/me'),
	updateMe: (patch: Partial<Omit<Me, 'email'>>) => request<Me>('PATCH', '/me', patch),
	today: () => request<Today>('GET', '/today'),

	key: () => request<{ key: KeyInfo | null }>('GET', '/llm-key'),
	testKey: (provider: Provider, apiKey: string) =>
		request<{ models: string[]; suggested: string }>('POST', '/llm-key/test', { provider, apiKey }),
	saveKey: (provider: Provider, apiKey: string, model: string) =>
		request<{ key: KeyInfo }>('PUT', '/llm-key', { provider, apiKey, model }),
	deleteKey: () => request('DELETE', '/llm-key'),

	items: () => request<{ items: ItemSummary[] }>('GET', '/items'),
	addItem: (input: { title: string; text: string; questionIntensity: QuestionIntensity; questionStyle: QuestionStyle }) =>
		request<{ item: ItemSummary }>('POST', '/items', input),
	item: (id: string) =>
		request<{ item: Item; sections: Section[]; links: { sectionIds: string[] }[]; activeSession: StudySession | null }>('GET', `/items/${id}`),
	rewriteQuestions: (id: string) => request<{ ok: true }>('POST', `/items/${id}/rewrite-questions`),
	deleteItem: (id: string) => request('DELETE', `/items/${id}`),
	startSession: (itemId: string, plannedMinutes: number) =>
		request<{ session: StudySession }>('POST', `/items/${itemId}/sessions`, { plannedMinutes }),
	finishSession: (id: string) => request<{ session: StudySession }>('POST', `/sessions/${id}/finish`),
	cancelSession: (id: string) => request('DELETE', `/sessions/${id}`),
	recall: (itemId: string, sectionIds: string[], text: string) => request<{ recall: Recall }>('POST', `/items/${itemId}/recall`, { sectionIds, text }),
	regradeRecall: (id: string) => request<{ recall: Recall }>('POST', `/recall/${id}/grade`),
	testQuestions: (itemId: string, sectionIds: string[], recallId?: string) =>
		request<{ itemTitle: string; itemStatus: ItemStatus; questions: Question[] }>('POST', `/items/${itemId}/test`, { sectionIds, recallId }),

	answer: (questionId: string, response: unknown) => request<AnswerResult>('POST', '/answers', { questionId, response }),
	due: () => request<{ questions: Question[] }>('GET', '/reviews/due'),
}
