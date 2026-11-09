import type { QuestionLevel } from './questions'

/**
 * Rules every generated question must pass before it is stored. They catch the ways a question
 * stops making the learner think: it gives the answer away, copies the text, asks for a
 * definition, or (for multiple choice) has an option that is obviously right or wrong.
 */

const STOPWORDS = new Set(
	'the a an and or but of to in on for with by from as at is are was were be been being it its this that these those which what why how when where who whom whose does do did can could would should will shall may might must not no than then there their they them you your we our into onto over under about after before because so such each every any all some more most other only also very just'.split(
		' ',
	),
)

const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
export const contentWords = (text: string) => words(text).filter((w) => w.length >= 4 && !STOPWORDS.has(w))

const BANNED_PROMPTS: [RegExp, string][] = [
	[/in your own words/i, 'asks to restate the text ("in your own words")'],
	[/^\s*(define|describe|summari[sz]e|list)\b/i, 'asks for a definition or summary instead of thinking'],
	[/^\s*explain\s+(?!why\b|how\b|what\s+(would|happens|goes)\b)/i, 'asks to "explain X" instead of why or how'],
	[/^\s*what\s+(is|are)\s+(a|an|the)?\s*[^,;?]{1,40}\?\s*$/i, 'asks "what is X", a definition'],
]

/** The longest run of the question's words that also appears, in order, in the text. */
function longestSharedRun(question: string, source: string) {
	const q = words(question)
	const s = ` ${words(source).join(' ')} `
	let best = 0
	for (let i = 0; i < q.length; i++)
		for (let j = i + best + 1; j <= q.length; j++) {
			if (!s.includes(` ${q.slice(i, j).join(' ')} `)) break
			best = j - i
		}
	return best
}

/** Copying 9 words in a row from the text means the question is a sentence of it, turned around. */
const MAX_COPIED_RUN = 8
/**
 * A question that contains nearly all of a must-have point has given that point away. Topic words
 * naturally appear in both, so short points and partial overlap are allowed.
 */
const MAX_POINT_OVERLAP = 0.8

type Stem = { prompt: string; code?: string }
type Checklist = Stem & { mustHave: string[] }
export type LintInput =
	| { type: 'short_answer' | 'find_error'; level: QuestionLevel; content: Checklist }
	| { type: 'mcq'; level: QuestionLevel; content: Stem & { options: string[]; answerIndex: number; whyWrong: string[] } }
	| { type: 'worked_problem'; level: QuestionLevel; content: Stem & { answer: number; tolerance: number; steps: string[] } }
	| { type: 'predict_output'; level: QuestionLevel; content: Stem & { code: string; output: string } }
	| { type: 'order_steps'; level: QuestionLevel; content: Stem & { steps: string[] } }

const squash = (text: string) => text.replace(/\s+/g, '')
/** A code example shorter than this is too small to count as copied. */
const MIN_COPIED_CODE = 40

function lintChecklist(q: { level: QuestionLevel; content: Checklist }, problems: string[]) {
	const { prompt, mustHave } = q.content
	if (q.level !== 'recall' && mustHave.length < 2) problems.push('needs at least 2 must-have points')
	const asked = new Set(contentWords(prompt))
	for (const point of mustHave) {
		const ws = contentWords(point)
		if (ws.length >= 3 && ws.filter((w) => asked.has(w)).length / ws.length >= MAX_POINT_OVERLAP) problems.push(`gives away the must-have point "${point}"`)
	}
}

/** Returns the rules the question breaks, as reasons the writer can act on. Empty means it passes. */
export function lintQuestion(q: LintInput, source: string): string[] {
	const problems: string[] = []
	const { prompt, code } = q.content
	for (const [re, why] of BANNED_PROMPTS) if (re.test(prompt)) problems.push(why)

	const copied = longestSharedRun(prompt, source)
	if (copied > MAX_COPIED_RUN) problems.push(`copies ${copied} words in a row from the text`)
	if (prompt.includes('`')) problems.push('puts code in the prompt: move it to "code", without backticks')
	if (code && squash(code).length >= MIN_COPIED_CODE && squash(source).includes(squash(code)))
		problems.push("copies the text's own code: change it, so the answer cannot be remembered from the page")

	switch (q.type) {
		case 'short_answer':
			lintChecklist(q, problems)
			break
		case 'find_error':
			lintChecklist(q, problems)
			if (!code && !/["“]/.test(prompt)) problems.push('needs the flawed code in "code", or the flawed claim in quotes in the prompt')
			break
		case 'mcq': {
			const { options, answerIndex, whyWrong } = q.content
			if (options.length !== 4) problems.push('multiple choice needs exactly 4 options')
			if (options.some((o) => /\b(all|none|both) of the (above|options)\b/i.test(o))) problems.push('uses "all/none of the above"')
			const lengths = options.map((o) => o.length)
			const right = lengths[answerIndex] ?? 0
			const longestWrong = Math.max(...lengths.filter((_, i) => i !== answerIndex))
			if (right > longestWrong * 1.5 && right - longestWrong > 15) problems.push('the right option is clearly the longest')
			if (Math.max(...lengths) > Math.min(...lengths) * 3 && Math.max(...lengths) > 30) problems.push('option lengths differ too much')
			if (whyWrong.filter((w, i) => i !== answerIndex && w.trim()).length < options.length - 1) problems.push('needs a reason why each wrong option is wrong')
			break
		}
		case 'worked_problem': {
			const { answer, tolerance, steps } = q.content
			if (!/\d/.test(prompt + (code ?? ''))) problems.push('a worked problem needs its own numbers in the prompt')
			if (!Number.isInteger(answer) && tolerance === 0) problems.push('a non-whole answer needs a tolerance for rounding')
			if (answer !== 0 && tolerance > Math.abs(answer) * 0.1) problems.push('the tolerance is so wide that a guess passes')
			if (steps.length < 2) problems.push('needs at least 2 key steps to grade the working')
			if (String(answer).length > 3 && prompt.includes(String(answer))) problems.push('gives the answer away in the prompt')
			break
		}
		case 'predict_output': {
			const { output } = q.content
			const lines = output.trim().split('\n')
			if (lines.length > 8 || output.length > 300) problems.push('the output is too long to predict exactly: at most 8 short lines')
			if (code!.split('\n').length > 25) problems.push('the code is too long to run in the head: at most 25 lines')
			if (output.trim().length >= 3 && (prompt.includes(output.trim()) || code!.includes(`# ${output.trim()}`) || code!.includes(`// ${output.trim()}`)))
				problems.push('gives the output away')
			break
		}
		case 'order_steps': {
			const { steps } = q.content
			if (steps.length < 4 || steps.length > 7) problems.push('needs 4 to 7 steps')
			if (new Set(steps.map((x) => x.trim().toLowerCase())).size !== steps.length) problems.push('has repeated steps')
			if (steps.some((x) => /^\s*(\d+[.)]|step\s+\d|first|then|next|finally|lastly)\b/i.test(x)))
				problems.push('a step gives away its position (numbers or "first", "then", "finally")')
			break
		}
	}
	return problems
}

/** Two prompts are duplicates when most of their content words are the same. */
export function isDuplicatePrompt(a: string, b: string) {
	const x = new Set(contentWords(a))
	const y = new Set(contentWords(b))
	const shared = [...x].filter((w) => y.has(w)).length
	const union = new Set([...x, ...y]).size
	return union >= 3 && shared / union >= 0.7
}

const normalised = (text: string) => text.toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, ' ').trim()

/**
 * True when the quote really is in the text, ignoring case, spacing and curly quotes. Every key
 * idea rests on a quote found this way; an idea whose quote isn't in the text is not stored.
 */
export function quoteInText(quote: string, text: string) {
	const q = normalised(quote).replace(/^["'\s]+|["'.\s]+$/g, '')
	return q.split(' ').length >= 4 && normalised(text).includes(q)
}

/** The longest cue, so it stays a short question. */
export const MAX_CUE_LENGTH = 160

/**
 * Returns what is wrong with a cue: the question a card is recalled from. It must be a short
 * question that doesn't give its idea away (3 or more of the idea's content words is a giveaway).
 */
export function lintCue(cue: string, idea: string): string[] {
	const problems: string[] = []
	if (!cue.trim().endsWith('?')) problems.push('the cue must be a question')
	if (cue.length > MAX_CUE_LENGTH) problems.push(`the cue is longer than ${MAX_CUE_LENGTH} characters`)
	const asked = new Set(contentWords(cue))
	const given = [...new Set(contentWords(idea))].filter((w) => asked.has(w))
	if (given.length >= 3) problems.push(`the cue gives the idea away (${given.join(', ')})`)
	return problems
}
