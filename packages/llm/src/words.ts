import { extractJson, type Term } from './generate'
import type { LlmProvider } from './providers'

const SYSTEM = `You define a word for a learner's vocabulary. Give its dictionary form in "word", and in "meaning" what it means in the sentence given, in plain words, in one short line: the sense used there, not every sense. When no sentence is given, write one natural example sentence in "sentence" that shows its most useful sense, and define it in that sense.

Write plain text: no Markdown. Reply with JSON only: {"word": "…", "meaning": "…", "sentence": "…"}`

/** Defines a word the learner added, in the sentence they met it in, or with a new example sentence. */
export async function defineWord(provider: LlmProvider, apiKey: string, model: string, input: { form: string; sentence: string | null }): Promise<Term> {
	const raw = await provider.complete(apiKey, {
		model,
		system: SYSTEM,
		user: input.sentence ? `Word: ${input.form}\nSentence: ${input.sentence}` : `Word: ${input.form}\nNo sentence: write one.`,
		json: true,
		maxTokens: 300,
	})
	const parsed = extractJson(raw) as { word?: unknown; meaning?: unknown; sentence?: unknown }
	const meaning = typeof parsed.meaning === 'string' ? parsed.meaning.trim() : ''
	if (!meaning) throw new Error('The model did not define the word')
	const word = typeof parsed.word === 'string' && parsed.word.trim() ? parsed.word.trim() : input.form
	// The sentence the learner read is kept as it is; a written example must actually use the word.
	const example = typeof parsed.sentence === 'string' ? parsed.sentence.trim() : ''
	const sentence = input.sentence ?? (example.toLowerCase().includes(input.form.toLowerCase()) ? example : '')
	if (!sentence) throw new Error('The model did not write an example sentence')
	return { word, form: input.form, sentence, meaning }
}
