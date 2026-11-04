import {
	isDuplicatePrompt,
	lintQuestion,
	MIN_ABOVE_RECALL,
	normalizeOutput,
	parseQuestionContent,
	QUESTION_LEVELS,
	shuffleMcq,
	shuffleSteps,
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
export const GENERATE_QUESTIONS_PROMPT_VERSION = 'questions-v7'
/** Questions written during reviews, when an idea has run out of unasked ones. Tests leave them out. */
export const REVIEW_PROMPT_VERSION = 'review-v2'

export type QuestionPrefs = {
	intensity: QuestionIntensity
	style: QuestionStyle
	/** A second call checks every question that passed the rules in code, including its answer key. */
	qualityCheck?: boolean
}
export type SectionInput = { title: string; level: number; text: string; wordCount: number }
/**
 * `section` and `alsoSections` index into the item's sections; `alsoSections` is set for linking
 * questions. `idea` indexes the key ideas of `section`: the idea the question tests, when known.
 */
export type GeneratedQuestion = { section: number; alsoSections: number[]; idea: number | null; type: QuestionType; level: QuestionLevel; content: unknown }
/** A hard or field-specific word, as it appears in the section, with the sentence and its meaning there. */
export type Term = { word: string; form: string; sentence: string; meaning: string }
export type Generated = { ideas: Map<number, string[]>; terms: Map<number, Term[]>; questions: GeneratedQuestion[] }
/**
 * Questions that failed the checks: on the model's first try, in the quality check, and the ones
 * dropped after the rewrite.
 */
export type OnRejected = (stage: 'first' | 'checked' | 'dropped', rejected: { prompt: string; reasons: string[] }[]) => void
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

const squash = (text: string) => text.replace(/\s+/g, ' ').trim()

/**
 * Keeps terms whose sentence really is in the section and really contains the word, so a test
 * never quotes a sentence the learner did not read.
 */
export function parseTerms(raw: unknown, source: string): Term[] {
	if (!Array.isArray(raw)) return []
	const text = squash(source).toLowerCase()
	const out: Term[] = []
	for (const t of raw.slice(0, 3) as Record<string, unknown>[]) {
		const [word, form, sentence, meaning] = [t?.word, t?.form, t?.sentence, t?.meaning].map((v) => (typeof v === 'string' ? squash(v) : ''))
		if (!word || !form || !sentence || !meaning || form.length > 60) continue
		if (!text.includes(sentence.toLowerCase()) || !sentence.toLowerCase().includes(form.toLowerCase())) continue
		if (out.some((x) => x.word.toLowerCase() === word.toLowerCase())) continue
		out.push({ word, form, sentence, meaning })
	}
	return out
}

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

/**
 * Models sometimes put a raw line break or tab inside a JSON string, usually in code. JSON forbids
 * that, so control characters inside strings are escaped; elsewhere they are whitespace and stay.
 */
function escapeControlCharacters(json: string): string {
	let out = ''
	let inString = false
	let escaped = false
	for (const ch of json) {
		if (inString && !escaped && ch < ' ') out += ch === '\n' ? '\\n' : ch === '\t' ? '\\t' : ch === '\r' ? '\\r' : ''
		else out += ch
		if (escaped) escaped = false
		else if (inString && ch === '\\') escaped = true
		else if (ch === '"') inString = !inString
	}
	return out
}

export function extractJson(text: string): unknown {
	const start = text.indexOf('{')
	const end = text.lastIndexOf('}')
	if (start < 0 || end < start) throw new Error('The model did not return JSON')
	const json = text.slice(start, end + 1)
	try {
		return JSON.parse(json)
	} catch {
		return JSON.parse(escapeControlCharacters(json))
	}
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
7. Pick each question's type from what the section teaches (the type guide below). Code in the text (marked <code>) calls for predict_output or find_error; formulas, quantities, or algorithms with numbers call for worked_problem; a process whose order matters calls for order_steps. Use short_answer for why and how, and where no other type fits.
8. Code goes in "code", exactly as typed, never in "prompt"; never use backticks. Write new code, not the text's own example.

Type guide:
- short_answer: "mustHave" lists 2 to 4 points a complete answer must make (1 is allowed only for recall), each a short claim, not a keyword. "reference" is a model answer of 1 to 3 sentences built from them. "misconceptions" lists wrong beliefs a half-understanding learner might state.
- mcq: exactly 4 options of similar length and style. Each wrong option is a real misconception that someone who half-understood would pick. No "all/none of the above". "whyWrong" has one entry per option: why that option is wrong, and "" for the right one. "explanation" says why the right one is right.
- worked_problem: a problem with new numbers whose answer is one number. "answer" is that number; "unit" its unit, or ""; "tolerance" how far off still counts (0 for exact whole numbers, enough for rounding otherwise). "solution" works it out step by step; "steps" lists the 2 to 4 key steps a correct working takes. Work it out yourself before you write "answer".
- predict_output: new code of at most 15 lines in "code" that exercises the idea; "output" is exactly what it prints, at most 8 short lines. Trace the code line by line before you write "output"; never put the output in a comment. "explanation" says why it prints that.
- find_error: flawed code in "code", or a flawed claim in quotes in the prompt, with one mistake a half-understanding learner would make. The learner says what is wrong and why. "mustHave" names what is wrong and why it is wrong (or the fix); "reference" and "misconceptions" as for short_answer.
- order_steps: 4 to 7 steps of a process in the right order (they are shuffled before the learner sees them), each a short phrase with no numbering and no "first", "then", or "finally". "explanation" says why the order matters.

Write plain text: no Markdown, no backticks, no bold. Put code on its own lines, exactly as it would be typed.

Every question names the key idea it tests in "idea": the idea's number in its section's list.

Every question has two separate fields: "type" is the format, exactly one of short_answer, mcq, worked_problem, predict_output, find_error, order_steps; "level" is the kind of thinking, one of recall, explain, apply, analyze, transfer.

Reply with JSON only, no prose and no code fence.`

const WRITTEN: QuestionType[] = ['short_answer', 'worked_problem', 'predict_output', 'find_error']
const CHOICE: QuestionType[] = ['mcq', 'order_steps']

const MIX: Record<QuestionStyle, string> = {
	mixed: 'Pick each type from the content, using the type guide. Mostly written types; about a quarter "mcq" or "order_steps", used only where wrong options are genuinely tempting or the order genuinely matters.',
	written: `Only these types, picked from the content: ${WRITTEN.join(', ')}.`,
	choice: `Only these types, picked from the content: ${CHOICE.join(', ')}.`,
}

const ALLOWED: Record<QuestionStyle, QuestionType[]> = { mixed: [...WRITTEN, ...CHOICE], written: WRITTEN, choice: CHOICE }

const SHAPES = `{"type": "short_answer", "level": "apply", "content": {"prompt": "…", "code": "optional", "reference": "…", "mustHave": ["…", "…"], "niceToHave": ["…"], "misconceptions": ["…"]}}
{"type": "mcq", "level": "analyze", "content": {"prompt": "…", "code": "optional", "options": ["…", "…", "…", "…"], "answerIndex": 0, "explanation": "…", "whyWrong": ["", "…", "…", "…"]}}
{"type": "worked_problem", "level": "apply", "content": {"prompt": "…", "answer": 0.25, "unit": "…", "tolerance": 0.005, "solution": "…", "steps": ["…", "…"], "misconceptions": ["…"]}}
{"type": "predict_output", "level": "apply", "content": {"prompt": "…", "code": "…", "output": "…", "explanation": "…"}}
{"type": "find_error", "level": "analyze", "content": {"prompt": "…", "code": "…", "reference": "…", "mustHave": ["…", "…"], "misconceptions": ["…"]}}
{"type": "order_steps", "level": "explain", "content": {"prompt": "…", "steps": ["…", "…", "…", "…"], "explanation": "…"}}`

/** Shuffles what the learner picks from, so the model's order (right answer first, steps in order) is no tell. */
const shuffled = (type: QuestionType, content: unknown) =>
	type === 'mcq' ? shuffleMcq(content as McqContent) : type === 'order_steps' ? shuffleSteps(content as { steps: string[] }) : content

const sectionBlock = (n: number, s: SectionInput, count: number) =>
	`<section number="${n}" title=${JSON.stringify(s.title)} questions="${count}">\n${s.text}\n</section>`

type Raw = { section?: unknown; sections?: unknown; idea?: unknown; type?: unknown; level?: unknown; content?: unknown }
type Candidate = GeneratedQuestion & { source: string }
type Rejected = { raw: unknown; section: number; alsoSections: number[]; idea: number | null; reasons: string[] }
type Item = { raw: Raw; section: number; alsoSections: number[]; idea: number | null; source: string }

/** The model numbers ideas from 1; anything that is not one of the section's ideas becomes null. */
const ideaIndex = (n: unknown, count: number) => {
	const i = Number(n) - 1
	return Number.isInteger(i) && i >= 0 && i < count ? i : null
}

/**
 * Checks model output against the rules in code. Accepted questions are returned with their
 * multiple-choice options shuffled; the rest come back with the reasons they failed.
 */
function check(
	items: Item[],
	prefs: QuestionPrefs,
	accepted: Candidate[],
	minAboveRecall = MIN_ABOVE_RECALL,
): Rejected[] {
	const rejected: Rejected[] = []
	for (const { raw, section, alsoSections, idea, source } of items) {
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
		if (reasons.length) rejected.push({ raw, section, alsoSections, idea, reasons })
		else
			accepted.push({
				section,
				alsoSections,
				idea,
				type: type as QuestionType,
				level,
				content: shuffled(type as QuestionType, content),
				source,
			})
	}
	// Too many recall questions: send the latest ones back to be rewritten at a higher level.
	const above = accepted.filter((q) => q.level !== 'recall').length
	let excess = Math.ceil(accepted.length * minAboveRecall) - above
	for (let i = accepted.length - 1; i >= 0 && excess > 0; i--) {
		const q = accepted[i]!
		if (q.level !== 'recall') continue
		accepted.splice(i, 1)
		rejected.push({ raw: { type: q.type, level: q.level, content: q.content }, section: q.section, alsoSections: q.alsoSections, idea: q.idea, reasons: ['too many recall questions: rewrite it at apply level or higher'] })
		excess--
	}
	return rejected
}

async function call(provider: LlmProvider, apiKey: string, model: string, user: string) {
	return extractJson(await provider.complete(apiKey, { model, system: RULES, user, json: true, maxTokens: MAX_REPLY_TOKENS }))
}

const CHECK_RULES = `You check retrieval-practice questions before a learner sees them. Each question comes with its answer key. Be a skeptical examiner: a wrong answer key or an unanswerable question teaches the learner something false.

Reject a question when any of these hold:
- The answer key is wrong or incomplete: a wrong right option, a second option that is also right, a must-have point that is false, a wrong number, or a wrong output.
- It cannot be answered from what the text teaches (with reasoning), or it needs trivia the text gives no reason to remember.
- It is ambiguous: a careful learner who understood the text could give a different answer and be right.
- It can be answered without thinking: by restating one sentence of the text, or because the prompt or options give it away.
- Its "mustHave" points are not what the question asks for.

Work out exact answers yourself, before you read the key:
- worked_problem: solve it and give your number in "answer".
- predict_output: trace the code line by line and give exactly what it prints in "output".

Reply with JSON only: {"checks": [{"id": 1, "answer": number (worked_problem only), "output": "…" (predict_output only), "verdict": "keep" | "reject", "problems": ["…"]}]}. "problems" says, for a rejected question, what to fix, in one short sentence each.`

type Check = { id?: unknown; answer?: unknown; output?: unknown; verdict?: unknown; problems?: unknown }

/**
 * Has the model check the questions in `accepted` from `from` on, and moves the ones it rejects
 * out, with its reasons. Exact answer keys are compared with the model's own working in code.
 * If the check itself fails, the questions are kept: they already passed the rules in code.
 */
async function qualityCheck(provider: LlmProvider, apiKey: string, model: string, context: string, accepted: Candidate[], from = 0): Promise<Rejected[]> {
	const list = accepted.slice(from)
	if (!list.length) return []
	let parsed: { checks?: Check[] }
	try {
		parsed = extractJson(
			await provider.complete(apiKey, {
				model,
				system: CHECK_RULES,
				user: `${context}\n\nQuestions:\n${JSON.stringify(list.map((q, k) => ({ id: k + 1, type: q.type, level: q.level, content: q.content })), null, 1)}`,
				json: true,
				maxTokens: MAX_REPLY_TOKENS,
			}),
		) as typeof parsed
	} catch {
		return []
	}
	const rejected: Rejected[] = []
	const out = new Set<Candidate>()
	for (const check of parsed.checks ?? []) {
		const q = list[Number(check.id) - 1]
		if (!q || out.has(q)) continue
		const reasons = check.verdict === 'reject' && Array.isArray(check.problems) ? check.problems.filter((p): p is string => typeof p === 'string' && p.trim().length > 0) : []
		if (check.verdict === 'reject' && !reasons.length) reasons.push('the quality check rejected it')
		const c = q.content as { answer?: number; tolerance?: number; output?: string }
		if (q.type === 'worked_problem' && typeof check.answer === 'number' && Math.abs(check.answer - c.answer!) > Math.max(c.tolerance ?? 0, Math.abs(c.answer!) * 1e-6))
			reasons.push(`the answer key says ${c.answer}, but working it out gives ${check.answer}: check the numbers`)
		if (q.type === 'predict_output' && typeof check.output === 'string' && normalizeOutput(check.output) !== normalizeOutput(c.output!))
			reasons.push(`the "output" key may be wrong: tracing the code gives ${JSON.stringify(check.output)}`)
		if (!reasons.length) continue
		out.add(q)
		rejected.push({ raw: { type: q.type, level: q.level, content: q.content }, section: q.section, alsoSections: q.alsoSections, idea: q.idea, reasons })
	}
	for (let i = accepted.length - 1; i >= from; i--) if (out.has(accepted[i]!)) accepted.splice(i, 1)
	return rejected
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
		return r ? [{ raw, section: r.section, alsoSections: r.alsoSections, idea: r.idea, source: sourceFor(r.section, r.alsoSections) }] : []
	})
	// Whatever still fails after one rewrite is dropped, so a bad question never reaches the learner.
	const answered = new Set(items.map((x) => x.raw))
	const unanswered = rejected.filter((_, k) => !(parsed.questions ?? []).some((q) => Number(q.id) === k + 1 && answered.has(q)))
	const before = accepted.length
	const failed = check(items, prefs, accepted)
	const checked = prefs.qualityCheck ? await qualityCheck(provider, apiKey, model, context, accepted, before) : []
	return [...failed, ...checked, ...unanswered]
}

/**
 * A linking question belongs to the section of the main idea it tests (its last section when the
 * model did not say) and is asked only when all its sections are picked.
 */
function linkItem(raw: Raw, refs: number[], ideaCount: (section: number) => number, sourceFor: (section: number, also: number[]) => string): Item {
	const main = Array.isArray(raw.idea) ? Number(raw.idea[0]) - 1 : NaN
	const owner = refs.includes(main) ? main : refs.at(-1)!
	const also = refs.filter((i) => i !== owner)
	const idea = owner === main ? ideaIndex((raw.idea as unknown[])[1], ideaCount(owner)) : null
	return { raw, section: owner, alsoSections: also, idea, source: sourceFor(owner, also) }
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
	attempt = 1,
): Promise<Generated> {
	const withText = batch.filter((i) => sections[i]!.wordCount > 0)
	const blocks = batch.map((i) => sectionBlock(i + 1, sections[i]!, questionCountFor(sections[i]!.wordCount, prefs.intensity))).join('\n\n')
	const linking = withText.length >= 3 ? Math.min(5, Math.round(withText.length / 3)) : 0
	const context = `${blocks}`
	let parsed: { sections?: { section?: unknown; ideas?: unknown; terms?: unknown; questions?: Raw[] }[]; links?: Raw[] }
	try {
		parsed = (await call(
			provider,
			apiKey,
			model,
			`${context}

For each section with text, list its key ideas (one sentence each, in reading order; these are what a learner should be able to recall without the text), and up to 3 terms worth learning: words a newcomer to the field might not know, or terms the text relies on. For each term give "form" exactly as it appears in the text, "word" its dictionary form, "sentence" the sentence it appears in, copied exactly, and "meaning" what it means in that sentence, in plain words. Leave out everyday words. Then write the number of questions given in its "questions" attribute, spread across the ideas. ${MIX[prefs.style]}${
				linking ? `\nAlso write ${linking} linking questions, each connecting ideas from 2 or more of these sections. A linking question's "idea" is [section, idea number] of the main idea it tests.` : ''
			}

Reply in this JSON shape:
{"sections": [{"section": 1, "ideas": ["…"], "terms": [{"word": "…", "form": "…", "sentence": "…", "meaning": "…"}], "questions": [{"idea": 1, …question}, …]}], "links": [{"sections": [1, 3], "idea": [3, 2], …question}]}
Question shapes:
${SHAPES}`,
		)) as typeof parsed
	} catch (err) {
		// An unreadable reply for one section is asked for once more; a bigger batch is split.
		if (batch.length < 2) {
			if (attempt < 2) return writeQuestions(provider, apiKey, model, sections, batch, prefs, onRejected, attempt + 1)
			throw err
		}
		const half = Math.ceil(batch.length / 2)
		const [a, b] = await Promise.all([
			writeQuestions(provider, apiKey, model, sections, batch.slice(0, half), prefs, onRejected),
			writeQuestions(provider, apiKey, model, sections, batch.slice(half), prefs, onRejected),
		])
		return { ideas: new Map([...a.ideas, ...b.ideas]), terms: new Map([...a.terms, ...b.terms]), questions: [...a.questions, ...b.questions] }
	}

	const inBatch = (n: unknown) => {
		const i = Number(n) - 1
		return batch.includes(i) ? i : null
	}
	const sourceFor = (section: number, also: number[]) => [section, ...also].map((i) => sections[i]!.text).join('\n\n')
	const ideas = new Map<number, string[]>()
	const terms = new Map<number, Term[]>()
	const items: Item[] = []
	for (const s of parsed.sections ?? []) {
		const i = inBatch(s.section)
		if (i === null) continue
		const list = Array.isArray(s.ideas) ? s.ideas.filter((x): x is string => typeof x === 'string' && x.trim().length > 0) : []
		ideas.set(i, list)
		terms.set(i, parseTerms(s.terms, sections[i]!.text))
		for (const raw of s.questions ?? []) items.push({ raw, section: i, alsoSections: [], idea: ideaIndex(raw.idea, list.length), source: sections[i]!.text })
	}
	for (const raw of parsed.links ?? []) {
		const refs = [...new Set((Array.isArray(raw.sections) ? raw.sections : []).map(inBatch).filter((i): i is number => i !== null))].sort((x, y) => x - y)
		if (refs.length < 2) continue
		items.push(linkItem(raw, refs, (i) => ideas.get(i)?.length ?? 0, sourceFor))
	}
	const accepted: Candidate[] = []
	const rejected = check(items, prefs, accepted)
	onRejected?.('first', describe(rejected))
	if (prefs.qualityCheck) {
		const checked = await qualityCheck(provider, apiKey, model, context, accepted)
		onRejected?.('checked', describe(checked))
		rejected.push(...checked)
	}
	const dropped = await rewrite(provider, apiKey, model, context, rejected, prefs, accepted, sourceFor)
	onRejected?.('dropped', describe(dropped))
	return { ideas, terms, questions: accepted.map(({ source: _, ...q }) => q) }
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

Write ${count} linking questions. Each must connect ideas from 2 or more sections that are far apart, so the learner has to combine them; prefer analyze and transfer. ${MIX[prefs.style]} A linking question's "idea" is [section, idea number] of the main idea it tests.

Reply in this JSON shape:
{"links": [{"sections": [2, 7], "idea": [7, 1], …question}]}
Question shapes:
${SHAPES}`,
	)) as { links?: Raw[] }
	const items: Item[] = []
	for (const raw of parsed.links ?? []) {
		const refs = [...new Set((Array.isArray(raw.sections) ? raw.sections : []).map((n) => Number(n) - 1).filter((i) => sections[i]?.ideas.length))].sort((x, y) => x - y)
		if (refs.length < 2) continue
		items.push(linkItem(raw, refs, (i) => sections[i]?.ideas.length ?? 0, sourceFor))
	}
	const accepted: Candidate[] = []
	const rejected = check(items, prefs, accepted)
	onRejected?.('first', describe(rejected))
	const ideasContext = `Key ideas of the text:\n\n${context}`
	if (prefs.qualityCheck) {
		const checked = await qualityCheck(provider, apiKey, model, ideasContext, accepted)
		onRejected?.('checked', describe(checked))
		rejected.push(...checked)
	}
	const dropped = await rewrite(provider, apiKey, model, ideasContext, rejected, prefs, accepted, sourceFor)
	onRejected?.('dropped', describe(dropped))
	return accepted.map(({ source: _, ...q }) => q)
}

export type IdeaRequest = {
	idea: string
	/** The text the idea comes from: its section, plus the others for a linking idea. */
	source: string
	level: QuestionLevel
	/** Prompts already asked on this idea, which the new question must not repeat. */
	asked: string[]
}

/**
 * Writes one new question per idea, at the level asked for, for ideas whose questions have all
 * been used. Questions that fail the checks are left out (null), so the caller can reuse an old one.
 */
export async function writeForIdeas(
	provider: LlmProvider,
	apiKey: string,
	model: string,
	requests: IdeaRequest[],
	style: QuestionStyle,
): Promise<({ type: QuestionType; level: QuestionLevel; content: unknown } | null)[]> {
	if (!requests.length) return []
	const blocks = requests
		.map(
			(r, i) => `<idea id="${i + 1}" level="${r.level}">
${r.idea}
<source>
${r.source}
</source>${r.asked.length ? `\n<already-asked>\n${r.asked.map((p) => `- ${p}`).join('\n')}\n</already-asked>` : ''}
</idea>`,
		)
		.join('\n\n')
	const parsed = (await call(
		provider,
		apiKey,
		model,
		`${blocks}

The learner has seen every question already asked on these ideas. For each idea, write one new question at its level that tests the same idea from a different angle, with new examples. It must not repeat or reword an already-asked question. ${MIX[style]}

Reply in this JSON shape, one entry per idea id:
{"questions": [{"id": 1, "type": "…", "level": "…", "content": {…}}]}
Content shapes:
${SHAPES}`,
	)) as { questions?: (Raw & { id?: unknown })[] }
	const out: ({ type: QuestionType; level: QuestionLevel; content: unknown } | null)[] = requests.map(() => null)
	for (const raw of parsed.questions ?? []) {
		const i = Number(raw.id) - 1
		const r = requests[i]
		if (!r || out[i]) continue
		const accepted: Candidate[] = []
		const rejected = check([{ raw, section: i, alsoSections: [], idea: null, source: r.source }], { intensity: 'standard', style }, accepted, 0)
		const q = accepted[0]
		if (rejected.length || !q || r.asked.some((p) => isDuplicatePrompt(p, (q.content as { prompt: string }).prompt))) continue
		out[i] = { type: q.type, level: q.level, content: q.content }
	}
	return out
}
