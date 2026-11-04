import { extractJson } from './generate'
import type { LlmProvider } from './providers'

/** How much the learner already knows. */
export const EXPLAIN_LEVELS = ['new', 'standard', 'expert'] as const
export type ExplainLevel = (typeof EXPLAIN_LEVELS)[number]
/** What kind of help: a plain explanation, an analogy, or a worked example. */
export const EXPLAIN_KINDS = ['explain', 'analogy', 'example'] as const
export type ExplainKind = (typeof EXPLAIN_KINDS)[number]

const LEVEL: Record<ExplainLevel, string> = {
	new: 'The learner is new to this. Use everyday words, define every term you must use, and build from what they already know.',
	standard: 'The learner knows the basics of the field. Be clear and direct, and use its terms where they help.',
	expert: 'The learner is advanced. Be precise and dense, use the field\'s terms, and mention the subtleties.',
}
const KIND: Record<ExplainKind, string> = {
	explain: 'Explain what the passage means and why it is true: the mechanism, not a restatement.',
	analogy: 'Give one analogy from everyday life that maps onto the passage part for part, then say where the analogy breaks down.',
	example: 'Work through one concrete example with new numbers, inputs, or code, step by step, showing the passage\'s idea at work.',
}

const EXPLAIN_SYSTEM = `You help a learner understand a passage they selected while reading. Stay grounded in the section it comes from: build on what the section says, and never contradict it. If you add something the section does not say, say so ("Beyond the text, …"). Never invent facts.

Keep it to what a learner can take in at once: at most about 150 words.

Write plain text: no Markdown, no backticks, no bold. Code goes in "code", exactly as typed; leave it out when there is none.

"quote" is the one sentence of the section your explanation relies on most, copied exactly, character for character.

Reply with JSON only: {"text": "…", "code": "…" (optional), "quote": "…"}`

export type Explanation = { text: string; code: string | null; quote: string | null }

const squash = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()

/** Explains a passage. The quote is kept only when it really is in the section, so it can be trusted. */
export async function explainPassage(
	provider: LlmProvider,
	apiKey: string,
	model: string,
	input: { section: string; passage: string; level: ExplainLevel; kind: ExplainKind },
): Promise<Explanation> {
	const raw = await provider.complete(apiKey, {
		model,
		system: EXPLAIN_SYSTEM,
		user: `<section>
${input.section}
</section>

<passage>
${input.passage}
</passage>

${LEVEL[input.level]}
${KIND[input.kind]}`,
		json: true,
		maxTokens: 1200,
	})
	const parsed = extractJson(raw) as { text?: unknown; code?: unknown; quote?: unknown }
	if (typeof parsed.text !== 'string' || !parsed.text.trim()) throw new Error('The model did not explain the passage')
	const quote = typeof parsed.quote === 'string' && parsed.quote.trim() && squash(input.section).includes(squash(parsed.quote)) ? parsed.quote.trim() : null
	const code = typeof parsed.code === 'string' && parsed.code.trim() ? parsed.code.replace(/\s+$/, '') : null
	return { text: parsed.text.trim(), code, quote }
}

/** Follow-up questions the student asks before it sums up. */
export const MAX_FOLLOW_UPS = 3

export type TeachMessage = { role: 'learner' | 'student'; text: string }
export type TeachTurn = { kind: 'question'; text: string } | { kind: 'done'; gaps: string[]; strengths: string[]; summary: string }

const TEACH_SYSTEM = `You play a curious, sharp student in a Feynman exercise. The learner teaches you one idea in their own words, without the text. You know the source text, but act as if you only know what the learner has told you.

While you have follow-up questions left, ask exactly one short question at a time that probes the weakest spot of the explanation so far: a step they skipped, a term they used without explaining, a "why" they did not give, or a case where what they said would give the wrong answer. Ask as a student would ("But why…", "What happens if…"), and never repeat a question. Never reveal, quote, or hint at the idea or the source text, not even to point out a contradiction: the learner must find the answer themselves. You may quote the learner's own words.

Finish ("done") when you have no follow-ups left, or earlier only if the explanation is complete and precise. Then:
- "gaps": each part of the idea, as the source text gives it, that the learner left out, got wrong, or could not explain when asked. One short sentence each, stating the fact the learner should learn, not a remark about the learner. Empty when there were none.
- "strengths": what they explained well, one short sentence each.
- "summary": 1 to 2 sentences to the learner as "you": how well they taught it and the one thing to work on.

Judge only against the source text and the idea. Be strict: a term named but not explained is a gap.

Write plain text: no Markdown, no backticks.

Reply with JSON only: {"kind": "question", "text": "…"} or {"kind": "done", "gaps": ["…"], "strengths": ["…"], "summary": "…"}`

const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim()) : [])

/**
 * One turn of a Feynman session: the student asks a follow-up, or sums up the gaps. With no
 * follow-ups left the student must sum up, so a session never takes more than four calls.
 */
export async function teachTurn(
	provider: LlmProvider,
	apiKey: string,
	model: string,
	input: { idea: string; source: string; messages: TeachMessage[] },
): Promise<TeachTurn> {
	const asked = input.messages.filter((m) => m.role === 'student').length
	const left = MAX_FOLLOW_UPS - asked
	const raw = await provider.complete(apiKey, {
		model,
		system: TEACH_SYSTEM,
		user: `<idea>
${input.idea}
</idea>

<source>
${input.source}
</source>

<conversation>
${input.messages.map((m) => `${m.role === 'learner' ? 'Learner' : 'Student'}: ${m.text}`).join('\n\n')}
</conversation>

${left > 0 ? `You have ${left} follow-up question${left === 1 ? '' : 's'} left.` : 'You have no follow-up questions left: reply with "done".'}`,
		json: true,
		maxTokens: 800,
	})
	const parsed = extractJson(raw) as { kind?: unknown; text?: unknown; gaps?: unknown; strengths?: unknown; summary?: unknown }
	if (left > 0 && parsed.kind === 'question' && typeof parsed.text === 'string' && parsed.text.trim()) return { kind: 'question', text: parsed.text.trim() }
	// A question when none are left, or an unreadable reply, would lose the gaps; fail so the turn can be retried.
	if (parsed.kind !== 'done') throw new Error(left > 0 ? 'The model did not ask or sum up' : 'The model did not sum up')
	return {
		kind: 'done',
		gaps: strings(parsed.gaps),
		strengths: strings(parsed.strengths),
		summary: typeof parsed.summary === 'string' ? parsed.summary.trim() : '',
	}
}
