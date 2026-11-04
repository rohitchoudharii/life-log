import {
	isDuplicatePrompt,
	lintQuestion,
	MIN_ABOVE_RECALL,
	parseQuestionContent,
	QUESTION_LEVELS,
	shuffleMcq,
	subtreeEnd,
	type LintInput,
	type McqContent,
	type QuestionIntensity,
	type QuestionLevel,
	type QuestionStyle,
	type QuestionType,
} from '@peak/core'
import type { LlmProvider } from './providers'

/** Bump when the prompt or the checks change, so stored questions record which rules made them. */
export const GENERATE_QUESTIONS_PROMPT_VERSION = 'questions-v4'

export type QuestionPrefs = { intensity: QuestionIntensity; style: QuestionStyle }
export type SectionInput = { title: string; level: number; text: string; wordCount: number }
/** `section` and `alsoSections` index into the item's sections; `alsoSections` is set for linking questions. */
export type GeneratedQuestion = { section: number; alsoSections: number[]; type: QuestionType; level: QuestionLevel; content: unknown }
export type Generated = { ideas: Map<number, string[]>; questions: GeneratedQuestion[] }
/** Questions that failed the checks: first on the model's first try, then the ones dropped after the rewrite. */
export type OnRejected = (stage: 'first' | 'dropped', rejected: { prompt: string; reasons: string[] }[]) => void
const describe = (r: Rejected[]) =>
	r.map((x) => ({ prompt: String((x.raw as { content?: { prompt?: unknown } })?.content?.prompt ?? '(no prompt)'), reasons: x.reasons }))

const PER_QUESTION_WORDS: Record<QuestionIntensity, number> = { quick: 150, standard: 70, thorough: 35 }
const LIMITS: Record<QuestionIntensity, [min: number, max: number]> = { quick: [1, 3], standard: [2, 8], thorough: [3, 20] }

/** How many questions a section gets: more for longer sections and higher intensity. */
export function questionCountFor(wordCount: number, intensity: QuestionIntensity) {
	if (wordCount === 0) return 0
	const [min, max] = LIMITS[intensity]
	return Math.max(min, Math.min(max, Math.round(wordCount / PER_QUESTION_WORDS[intensity])))
}

/** Rough reply size of one question with its checklist, as JSON. */
const TOKENS_PER_QUESTION = 350
/** The most reply one call is planned for; the request allows more, as headroom. */
export const REPLY_BUDGET_TOKENS = 12_000
const MAX_REPLY_TOKENS = 16_000

/**
 * Groups sections into calls. Each top-level section and its subsections (a chapter) stays in one
 * call when it fits; neighbouring chapters share a call while the reply stays under budget, and a
 * chapter too big for one reply is split in reading order.
 */
export function planBatches(sections: Pick<SectionInput, 'level' | 'wordCount'>[], intensity: QuestionIntensity, budget = REPLY_BUDGET_TOKENS): number[][] {
	const cost = (i: number) => questionCountFor(sections[i]!.wordCount, intensity) * TOKENS_PER_QUESTION
	const levels = sections.map((s) => s.level)
	const batches: number[][] = []
	let current: number[] = []
	let used = 0
	const close = () => {
		if (current.length) batches.push(current)
		current = []
		used = 0
	}
	for (let start = 0; start < sections.length; ) {
		const end = subtreeEnd(levels, start)
		const chapter = Array.from({ length: end - start }, (_, k) => start + k)
		const total = chapter.reduce((n, i) => n + cost(i), 0)
		if (total <= budget) {
			if (used + total > budget) close()
			current.push(...chapter)
			used += total
		} else {
			close()
			for (const i of chapter) {
				if (used + cost(i) > budget) close()
				current.push(i)
				used += cost(i)
			}
			close()
		}
		start = end
	}
	close()
	// Batches of only empty parent headings have nothing to ask about.
	return batches.filter((b) => b.some((i) => sections[i]!.wordCount > 0))
}

export function extractJson(text: string): unknown {
	const start = text.indexOf('{')
	const end = text.lastIndexOf('}')
	if (start < 0 || end < start) throw new Error('The model did not return JSON')
	return JSON.parse(text.slice(start, end + 1))
}

const RULES = `You write retrieval-practice questions that force the learner to think hard, following research on the testing effect (Roediger, Karpicke, Bjork, Agarwal) and deliberate practice (Peak, Ericsson and Pool). The learner answers from memory, right after reading, without the text.

Every question targets one key idea and one level:
- recall: state a fact that later ideas depend on (use sparingly)
- explain: why or how something works, or what goes wrong without it
- apply: use the idea on a new case, new numbers, or new code
- analyze: compare, find the error in a flawed claim or code, predict a consequence of a change
- transfer: use the idea outside the text's own example or domain

Hard rules:
1. At least 60% of questions are explain, apply, analyze, or transfer.
2. Never put the answer, its key terms, or a sentence of the text in the question.
3. Never ask "explain X", "what is X", "define", "describe", "summarize", or "in your own words". Ask why, how, what if, predict, compute, find the error, or compare.
4. Use new examples: different numbers, inputs, or code than the text uses, so the answer cannot be copied from memory of the page.
5. Answerable from what the text teaches, not from trivia (no dates, names, or numbers that do not matter to understanding). Never invent facts.
6. No two questions test the same point at the same level.
7. short_answer: "mustHave" lists 2 to 4 points a complete answer must make (1 is allowed only for recall), each a short claim, not a keyword. "reference" is a model answer of 1 to 3 sentences built from them. "misconceptions" lists wrong beliefs a half-understanding learner might state.
8. mcq: exactly 4 options of similar length and style. Each wrong option is a real misconception that someone who half-understood would pick. No "all/none of the above". "whyWrong" has one entry per option: why that option is wrong, and "" for the right one. "explanation" says why the right one is right.

Write plain text: no Markdown, no backticks, no bold. Put code on its own lines, exactly as it would be typed.

Every question has two separate fields: "type" is the format, exactly "short_answer" or "mcq"; "level" is the kind of thinking, one of recall, explain, apply, analyze, transfer.

Reply with JSON only, no prose and no code fence.`

const MIX: Record<QuestionStyle, string> = {
	mixed: 'Mostly "short_answer"; about a quarter "mcq", used only where wrong options can be genuinely tempting.',
	written: 'Only "short_answer".',
	choice: 'Only "mcq".',
}

const ALLOWED: Record<QuestionStyle, QuestionType[]> = { mixed: ['short_answer', 'mcq'], written: ['short_answer'], choice: ['mcq'] }

const SHAPES = `{"type": "short_answer", "level": "apply", "content": {"prompt": "…", "reference": "…", "mustHave": ["…", "…"], "niceToHave": ["…"], "misconceptions": ["…"]}}
{"type": "mcq", "level": "analyze", "content": {"prompt": "…", "options": ["…", "…", "…", "…"], "answerIndex": 0, "explanation": "…", "whyWrong": ["", "…", "…", "…"]}}`

const sectionBlock = (n: number, s: SectionInput, count: number) =>
	`<section number="${n}" title=${JSON.stringify(s.title)} questions="${count}">\n${s.text}\n</section>`

type Raw = { section?: unknown; sections?: unknown; type?: unknown; level?: unknown; content?: unknown }
type Candidate = GeneratedQuestion & { source: string }
type Rejected = { raw: unknown; section: number; alsoSections: number[]; reasons: string[] }

/**
 * Checks model output against the rules in code. Accepted questions are returned with their
 * multiple-choice options shuffled; the rest come back with the reasons they failed.
 */
function check(
	items: { raw: Raw; section: number; alsoSections: number[]; source: string }[],
	prefs: QuestionPrefs,
	accepted: Candidate[],
): Rejected[] {
	const rejected: Rejected[] = []
	for (const { raw, section, alsoSections, source } of items) {
		const reasons: string[] = []
		const type = String(raw.type)
		const level = String(raw.level) as QuestionLevel
		const content = parseQuestionContent(type, raw.content) as LintInput['content'] | null
		if (!content) reasons.push(`does not match the ${type} shape`)
		else if (!ALLOWED[prefs.style].includes(type as QuestionType)) reasons.push(`this reading asks for ${MIX[prefs.style]}`)
		if (!QUESTION_LEVELS.includes(level)) reasons.push('needs a level: recall, explain, apply, analyze, or transfer')
		if (content && !reasons.length) {
			reasons.push(...lintQuestion({ type, level, content } as LintInput, source))
			const dupe = accepted.some((q) => q.section === section && isDuplicatePrompt((q.content as { prompt: string }).prompt, content.prompt))
			if (dupe) reasons.push('repeats another question on this section')
		}
		if (reasons.length) rejected.push({ raw, section, alsoSections, reasons })
		else
			accepted.push({
				section,
				alsoSections,
				type: type as QuestionType,
				level,
				content: type === 'mcq' ? shuffleMcq(content as McqContent) : content,
				source,
			})
	}
	// Too many recall questions: send the latest ones back to be rewritten at a higher level.
	const above = accepted.filter((q) => q.level !== 'recall').length
	let excess = Math.ceil(accepted.length * MIN_ABOVE_RECALL) - above
	for (let i = accepted.length - 1; i >= 0 && excess > 0; i--) {
		const q = accepted[i]!
		if (q.level !== 'recall') continue
		accepted.splice(i, 1)
		rejected.push({ raw: { type: q.type, level: q.level, content: q.content }, section: q.section, alsoSections: q.alsoSections, reasons: ['too many recall questions: rewrite it at apply level or higher'] })
		excess--
	}
	return rejected
}

async function call(provider: LlmProvider, apiKey: string, model: string, user: string) {
	return extractJson(await provider.complete(apiKey, { model, system: RULES, user, json: true, maxTokens: MAX_REPLY_TOKENS }))
}

/** Sends the questions that failed the checks back once, with the reasons, and keeps replacements that pass. */
async function rewrite(
	provider: LlmProvider,
	apiKey: string,
	model: string,
	context: string,
	rejected: Rejected[],
	prefs: QuestionPrefs,
	accepted: Candidate[],
	sourceFor: (section: number, also: number[]) => string,
): Promise<Rejected[]> {
	if (!rejected.length) return []
	const list = rejected.map((r, k) => ({ id: k + 1, section: r.section + 1, problems: r.reasons, question: r.raw }))
	const parsed = (await call(
		provider,
		apiKey,
		model,
		`${context}

These questions broke the rules. Write one replacement for each that fixes every problem listed, on the same idea and section. ${MIX[prefs.style]}

${JSON.stringify(list, null, 1)}

Reply in this JSON shape, one entry per id:
{"questions": [{"id": 1, "type": "…", "level": "…", "content": {…}}]}
Content shapes:
${SHAPES}`,
	)) as { questions?: (Raw & { id?: unknown })[] }
	const items = (parsed.questions ?? []).flatMap((raw) => {
		const r = rejected[Number(raw.id) - 1]
		return r ? [{ raw, section: r.section, alsoSections: r.alsoSections, source: sourceFor(r.section, r.alsoSections) }] : []
	})
	// Whatever still fails after one rewrite is dropped, so a bad question never reaches the learner.
	const answered = new Set(items.map((x) => x.raw))
	const unanswered = rejected.filter((_, k) => !(parsed.questions ?? []).some((q) => Number(q.id) === k + 1 && answered.has(q)))
	return [...check(items, prefs, accepted), ...unanswered]
}

/**
 * Writes questions for one batch of sections in one call, checks them in code, and rewrites the
 * failures once. If the reply cannot be parsed (usually cut off for length), the batch is split
 * in half and retried.
 */
export async function writeQuestions(
	provider: LlmProvider,
	apiKey: string,
	model: string,
	sections: SectionInput[],
	batch: number[],
	prefs: QuestionPrefs,
	onRejected?: OnRejected,
): Promise<Generated> {
	const withText = batch.filter((i) => sections[i]!.wordCount > 0)
	const blocks = batch.map((i) => sectionBlock(i + 1, sections[i]!, questionCountFor(sections[i]!.wordCount, prefs.intensity))).join('\n\n')
	const linking = withText.length >= 3 ? Math.min(5, Math.round(withText.length / 3)) : 0
	const context = `${blocks}`
	let parsed: { sections?: { section?: unknown; ideas?: unknown; questions?: Raw[] }[]; links?: Raw[] }
	try {
		parsed = (await call(
			provider,
			apiKey,
			model,
			`${context}

For each section with text, list its key ideas (one sentence each, in reading order), then write the number of questions given in its "questions" attribute. ${MIX[prefs.style]}${
				linking ? `\nAlso write ${linking} linking questions, each connecting ideas from 2 or more of these sections.` : ''
			}

Reply in this JSON shape:
{"sections": [{"section": 1, "ideas": ["…"], "questions": [question, …]}], "links": [{"sections": [1, 3], …question}]}
Question shapes:
${SHAPES}`,
		)) as typeof parsed
	} catch (err) {
		if (batch.length < 2) throw err
		const half = Math.ceil(batch.length / 2)
		const [a, b] = await Promise.all([
			writeQuestions(provider, apiKey, model, sections, batch.slice(0, half), prefs, onRejected),
			writeQuestions(provider, apiKey, model, sections, batch.slice(half), prefs, onRejected),
		])
		return { ideas: new Map([...a.ideas, ...b.ideas]), questions: [...a.questions, ...b.questions] }
	}

	const inBatch = (n: unknown) => {
		const i = Number(n) - 1
		return batch.includes(i) ? i : null
	}
	const sourceFor = (section: number, also: number[]) => [section, ...also].map((i) => sections[i]!.text).join('\n\n')
	const ideas = new Map<number, string[]>()
	const items: Parameters<typeof check>[0] = []
	for (const s of parsed.sections ?? []) {
		const i = inBatch(s.section)
		if (i === null) continue
		if (Array.isArray(s.ideas)) ideas.set(i, s.ideas.filter((x): x is string => typeof x === 'string' && x.trim().length > 0))
		for (const raw of s.questions ?? []) items.push({ raw, section: i, alsoSections: [], source: sections[i]!.text })
	}
	for (const raw of parsed.links ?? []) {
		const refs = [...new Set((Array.isArray(raw.sections) ? raw.sections : []).map(inBatch).filter((i): i is number => i !== null))].sort((x, y) => x - y)
		if (refs.length < 2) continue
		// A linking question belongs to its last section and is asked only when all of them are picked.
		const owner = refs.at(-1)!
		items.push({ raw, section: owner, alsoSections: refs.slice(0, -1), source: sourceFor(owner, refs.slice(0, -1)) })
	}
	const accepted: Candidate[] = []
	const rejected = check(items, prefs, accepted)
	onRejected?.('first', describe(rejected))
	const dropped = await rewrite(provider, apiKey, model, context, rejected, prefs, accepted, sourceFor)
	onRejected?.('dropped', describe(dropped))
	return { ideas, questions: accepted.map(({ source: _, ...q }) => q) }
}

/**
 * Writes questions that connect sections from different batches. It sees only each section's key
 * ideas, not the full text, so the call stays small however long the item is.
 */
export async function linkSections(
	provider: LlmProvider,
	apiKey: string,
	model: string,
	sections: { title: string; ideas: string[] }[],
	prefs: QuestionPrefs,
	onRejected?: OnRejected,
): Promise<GeneratedQuestion[]> {
	const usable = sections.map((s, i) => ({ ...s, i })).filter((s) => s.ideas.length)
	if (usable.length < 2) return []
	const count = Math.max(2, Math.min(10, Math.round(usable.length / 3)))
	const context = usable.map((s) => `<section number="${s.i + 1}" title=${JSON.stringify(s.title)}>\n${s.ideas.map((x) => `- ${x}`).join('\n')}\n</section>`).join('\n\n')
	const sourceFor = (section: number, also: number[]) => [section, ...also].map((i) => sections[i]?.ideas.join('\n') ?? '').join('\n')
	const parsed = (await call(
		provider,
		apiKey,
		model,
		`These are the key ideas of each section of one text.

${context}

Write ${count} linking questions. Each must connect ideas from 2 or more sections that are far apart, so the learner has to combine them; prefer analyze and transfer. ${MIX[prefs.style]}

Reply in this JSON shape:
{"links": [{"sections": [2, 7], …question}]}
Question shapes:
${SHAPES}`,
	)) as { links?: Raw[] }
	const items: Parameters<typeof check>[0] = []
	for (const raw of parsed.links ?? []) {
		const refs = [...new Set((Array.isArray(raw.sections) ? raw.sections : []).map((n) => Number(n) - 1).filter((i) => sections[i]?.ideas.length))].sort((x, y) => x - y)
		if (refs.length < 2) continue
		items.push({ raw, section: refs.at(-1)!, alsoSections: refs.slice(0, -1), source: sourceFor(refs.at(-1)!, refs.slice(0, -1)) })
	}
	const accepted: Candidate[] = []
	const rejected = check(items, prefs, accepted)
	onRejected?.('first', describe(rejected))
	const dropped = await rewrite(provider, apiKey, model, `Key ideas of the text:\n\n${context}`, rejected, prefs, accepted, sourceFor)
	onRejected?.('dropped', describe(dropped))
	return accepted.map(({ source: _, ...q }) => q)
}
