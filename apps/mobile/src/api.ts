import type { Block, PointStatus, QuestionIntensity, QuestionPrompt, QuestionStyle, Rating } from '@life-log-club/core'
import Constants from 'expo-constants'
import * as SecureStore from 'expo-secure-store'
import { Platform } from 'react-native'

// In development a phone reaches the API on the same machine that serves the app bundle.
const devHost = Constants.expoConfig?.hostUri?.split(':')[0]
export const BASE =
	process.env.EXPO_PUBLIC_API_URL ??
	(Platform.OS !== 'web' && devHost ? `http://${devHost}:8787` : 'http://localhost:8787')
const TOKEN_KEY = 'lifelogclub.session'

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
		// A form (file upload) sets its own content type with the multipart boundary.
		const form = body instanceof FormData
		res = await fetch(BASE + path, {
			method,
			headers: { ...(!form && { 'content-type': 'application/json' }), ...(token && { authorization: `Bearer ${token}` }) },
			body: body === undefined ? undefined : form ? body : JSON.stringify(body),
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
	ideaCount: number
	ideasLearned: number
	createdAt: string
	/** When the reading was last opened, or null if never. */
	lastOpenedAt: string | null
	sourceUrl: string | null
	/** The bucket it is in and its place there, or null for none. */
	collectionId: string | null
	collectionPosition: number | null
	/** The reading it was imported from by a link, or null. */
	parentId: string | null
}
export type Collection = { id: string; name: string }
type ItemPrefs = { collectionId?: string | null }
export type Section = {
	id: string
	position: number
	/** 1 to 3; a section's subsections follow it with a deeper level. */
	level: number
	title: string
	blocks: Block[]
	wordCount: number
	questionCount: number
	/** Picked in Manage test at some point. */
	questionsWanted: boolean
}
export type Item = Omit<ItemSummary, 'sectionCount' | 'questionCount' | 'ideaCount' | 'ideasLearned' | 'collectionPosition'> & {
	/** Importing every page it links to: running, finished, or never asked for. */
	linksImport: 'importing' | 'done' | null
	/** How its quiz was last made in Manage test; null until it has one. */
	questionIntensity: QuestionIntensity | null
	questionStyle: QuestionStyle | null
}
export type StudySession = {
	id: string
	itemId: string
	plannedMinutes: number
	startedAt: string
	endedAt: string | null
}
/** `ideaId` is the key idea the question tests; null for questions from before ideas. */
export type Question = QuestionPrompt & { id: string; ideaId: string | null; itemTitle?: string }
export type RecallIdea = { id: string; text: string; section: string; status: PointStatus | null }
export type Recall = { id: string; text: string; feedback: string | null; gradeError: string | null; ideas: RecallIdea[] }
/** `dueAt` is when the idea comes back; null for retry-round answers and questions with no idea. */
export type AnswerResult = { correct: boolean; rating: Rating; reveal: Record<string, unknown>; dueAt: string | null; practice: boolean }
export type Today = {
	due: number
	reviewedToday: number
	dailyReviewCap: number
	streak: number
	ongoing: { id: string; title: string }[]
}
export type Me = {
	email: string
	timezone: string
	reminderTime: string | null
	dailyReviewCap: number
	qualityCheck: boolean
	/** The settings Manage test starts on: how many questions, and which kinds. */
	questionIntensity: QuestionIntensity
	questionStyle: QuestionStyle
	/** Who explanations are written for: the level picked last in the reader. */
	explainLevel: ExplainLevel
}
export type ExplainLevel = 'new' | 'standard' | 'expert'
export type ExplainKind = 'explain' | 'analogy' | 'example'
export type TeachMessage = { role: 'learner' | 'student'; text: string }
type NoteBase = { id: string; itemId: string; sectionId: string; ideaId: string | null; passage: string | null; createdAt: string }
export type Note =
	| (NoteBase & { kind: 'explanation'; detail: { level: ExplainLevel; kind: ExplainKind; text: string; code: string | null; quote: string | null } })
	| (NoteBase & {
			kind: 'feynman'
			detail: { idea: string; messages: TeachMessage[]; result: { gaps: string[]; strengths: string[]; summary: string } | null }
	  })
export type IdeaRef = { id: string; text: string; section: string }
export type Word = {
	id: string
	itemId: string | null
	itemTitle: string | null
	word: string
	form: string
	sentence: string
	meaning: string
	/** Null until it is first reviewed. */
	dueAt: string | null
	mastered: boolean
	level: number
}
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

	items: () => request<{ items: ItemSummary[]; collections: Collection[] }>('GET', '/items'),
	addItem: (input: { title: string; text: string } & ItemPrefs) => request<{ item: ItemSummary }>('POST', '/items', input),
	addUrl: (input: { url: string; importLinks?: boolean } & ItemPrefs) => request<{ item: ItemSummary }>('POST', '/items/url', input),
	/** Uploads an EPUB or PDF. `file` is a File on the web and a { uri, name, type } on phones. */
	uploadItem: async (file: Blob | { uri: string; name: string; type: string }, prefs: ItemPrefs) => {
		const form = new FormData()
		form.append('file', file as Blob)
		if (prefs.collectionId) form.append('collectionId', prefs.collectionId)
		return request<{ item: ItemSummary }>('POST', '/items/upload', form)
	},
	addCollection: (name: string) => request<{ collection: Collection }>('POST', '/collections', { name }),
	renameCollection: (id: string, name: string) => request<{ collection: Collection }>('PATCH', `/collections/${id}`, { name }),
	deleteCollection: (id: string) => request('DELETE', `/collections/${id}`),
	orderCollection: (id: string, itemIds: string[]) => request('PUT', `/collections/${id}/order`, { itemIds }),
	moveItem: (id: string, collectionId: string | null) => request('PUT', `/items/${id}/collection`, { collectionId }),
	item: (id: string) =>
		request<{
			item: Item
			sections: Section[]
			links: { sectionIds: string[] }[]
			activeSession: StudySession | null
			/** Linked pages that are already readings: address → reading id. */
			linked: Record<string, string>
			children: { id: string; title: string; sourceUrl: string | null }[]
			parent: { id: string; title: string } | null
			/** The reading after this one in its bucket. */
			next: { id: string; title: string } | null
		}>('GET', `/items/${id}`),
	/** Puts `nextId` right after this reading, in its bucket (a new one when it is in none). */
	setNext: (id: string, nextId: string) => request<{ ok: true }>('PUT', `/items/${id}/next`, { itemId: nextId }),
	/** Imports the page a link in a reading points at, nested under it; an existing reading comes back instead. */
	importLink: (itemId: string, url: string) => request<{ item: ItemSummary; existed: boolean }>('POST', `/items/${itemId}/links`, { url }),
	/** Writes questions for these sections, replacing any they have. */
	generateQuiz: (id: string, input: { sectionIds: string[]; intensity: QuestionIntensity; style: QuestionStyle }) =>
		request<{ sections: number }>('POST', `/items/${id}/generate`, input),
	deleteItem: (id: string) => request('DELETE', `/items/${id}`),
	startSession: (itemId: string, plannedMinutes: number) =>
		request<{ session: StudySession }>('POST', `/items/${itemId}/sessions`, { plannedMinutes }),
	finishSession: (id: string) => request<{ session: StudySession }>('POST', `/sessions/${id}/finish`),
	cancelSession: (id: string) => request('DELETE', `/sessions/${id}`),
	words: () => request<{ words: Word[] }>('GET', '/words'),
	addWord: (input: { word: string; sentence?: string; itemId?: string }) => request<{ word: Word }>('POST', '/words', input),
	deleteWord: (id: string) => request('DELETE', `/words/${id}`),
	wordsDue: () => request<{ questions: Question[] }>('GET', '/words/due'),
	answerWord: (id: string, response: unknown, practice = false) => request<AnswerResult>('POST', `/words/${id}/answer`, { response, practice }),
	notes: (itemId: string) => request<{ notes: Note[] }>('GET', `/items/${itemId}/notes`),
	explain: (itemId: string, input: { sectionId: string; passage: string; level?: ExplainLevel; kind: ExplainKind }) =>
		request<{ note: Note }>('POST', `/items/${itemId}/explain`, input),
	deleteNote: (id: string) => request('DELETE', `/notes/${id}`),
	ideas: (itemId: string) => request<{ ideas: IdeaRef[] }>('GET', `/items/${itemId}/ideas`),
	startTeaching: (ideaId: string, text: string) => request<{ note: Note }>('POST', `/ideas/${ideaId}/teach`, { text }),
	teach: (noteId: string, text: string) => request<{ note: Note }>('POST', `/notes/${noteId}/teach`, { text }),
	recall: (itemId: string, sectionIds: string[], text: string) => request<{ recall: Recall }>('POST', `/items/${itemId}/recall`, { sectionIds, text }),
	regradeRecall: (id: string) => request<{ recall: Recall }>('POST', `/recall/${id}/grade`),
	testQuestions: (itemId: string, sectionIds: string[], recallId?: string) =>
		request<{ itemTitle: string; itemStatus: ItemStatus; questions: Question[] }>('POST', `/items/${itemId}/test`, { sectionIds, recallId }),

	answer: (questionId: string, response: unknown, practice = false) => request<AnswerResult>('POST', '/answers', { questionId, response, practice }),
	due: () => request<{ questions: Question[] }>('GET', '/reviews/due'),
	retry: (ideaIds: string[], exclude: string[]) => request<{ questions: Question[] }>('POST', '/reviews/retry', { ideaIds, exclude }),
}
