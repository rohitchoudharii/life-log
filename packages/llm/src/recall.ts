import type { PointStatus } from '@peak/core'
import { extractJson } from './generate'
import type { LlmProvider } from './providers'

const STATUSES: PointStatus[] = ['covered', 'vague', 'missing']

const GRADE_SYSTEM = `A learner just read a text, closed it, and wrote down everything they remember (a "brain dump"). You check it against the text's key ideas. You do not give a score.

For each key idea, decide:
- "covered": the dump states the idea, in any words or order. Its reasoning must be there when the idea has one.
- "vague": the dump gestures at it, names its term without saying what it means, or gets it partly right.
- "missing": the dump does not contain it, or states it wrongly.

Be strict: credit only what is written. Ignore spelling, grammar, and structure; lists and fragments are fine.

Feedback: 1 to 3 short sentences to the learner as "you". Name what came back well and the most important idea that did not. Correct anything they wrote that is wrong.

Write the feedback as plain text: no Markdown, no backticks.

Reply with JSON only: {"ideas": ["covered" | "vague" | "missing", …one per key idea, in order], "feedback": "…"}`

export type RecallVerdict = { ideas: PointStatus[]; feedback: string }

/** Grades a brain dump against key ideas. An idea the model gives no readable verdict for counts as missing. */
export async function gradeRecall(provider: LlmProvider, apiKey: string, model: string, input: { ideas: string[]; text: string }): Promise<RecallVerdict> {
	const raw = await provider.complete(apiKey, {
		model,
		system: GRADE_SYSTEM,
		user: `Key ideas:
${input.ideas.map((x, i) => `${i + 1}. ${x}`).join('\n')}

Brain dump:
"""
${input.text}
"""`,
		json: true,
		maxTokens: 300 + input.ideas.length * 20,
	})
	const parsed = extractJson(raw) as { ideas?: unknown; feedback?: unknown }
	if (!Array.isArray(parsed.ideas)) throw new Error('The model did not grade the ideas')
	const list = parsed.ideas as unknown[]
	return {
		ideas: input.ideas.map((_, i) => (STATUSES.includes(list[i] as PointStatus) ? (list[i] as PointStatus) : 'missing')),
		feedback: typeof parsed.feedback === 'string' ? parsed.feedback.trim() : '',
	}
}

/**
 * Lists a section's key ideas, for sections prepared before ideas were stored. New sections get
 * their ideas while their questions are written.
 */
export async function extractIdeas(provider: LlmProvider, apiKey: string, model: string, sections: { title: string; text: string }[]): Promise<string[][]> {
	const raw = await provider.complete(apiKey, {
		model,
		system: `List the key ideas of each section: what a learner should be able to recall without the text. One sentence each, in reading order, 2 to 8 per section. Plain text, no Markdown. Reply with JSON only.`,
		user: `${sections.map((s, i) => `<section number="${i + 1}" title=${JSON.stringify(s.title)}>\n${s.text}\n</section>`).join('\n\n')}

Reply in this JSON shape: {"sections": [{"section": 1, "ideas": ["…"]}]}`,
		json: true,
		maxTokens: 400 + sections.length * 300,
	})
	const parsed = extractJson(raw) as { sections?: { section?: unknown; ideas?: unknown }[] }
	const out: string[][] = sections.map(() => [])
	for (const s of parsed.sections ?? []) {
		const i = Number(s.section) - 1
		if (out[i] && Array.isArray(s.ideas)) out[i] = s.ideas.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
	}
	return out
}
