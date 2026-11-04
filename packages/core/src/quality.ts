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
const contentWords = (text: string) => words(text).filter((w) => w.length >= 4 && !STOPWORDS.has(w))

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

export type LintInput =
	| { type: 'short_answer'; level: QuestionLevel; content: { prompt: string; mustHave: string[] } }
	| { type: 'mcq'; level: QuestionLevel; content: { prompt: string; options: string[]; answerIndex: number; whyWrong: string[] } }

/** Returns the rules the question breaks, as reasons the writer can act on. Empty means it passes. */
export function lintQuestion(q: LintInput, source: string): string[] {
	const problems: string[] = []
	const prompt = q.content.prompt
	for (const [re, why] of BANNED_PROMPTS) if (re.test(prompt)) problems.push(why)

	const copied = longestSharedRun(prompt, source)
	if (copied > MAX_COPIED_RUN) problems.push(`copies ${copied} words in a row from the text`)

	if (q.type === 'short_answer') {
		const { mustHave } = q.content
		if (q.level !== 'recall' && mustHave.length < 2) problems.push('needs at least 2 must-have points')
		const asked = new Set(contentWords(prompt))
		for (const point of mustHave) {
			const ws = contentWords(point)
			if (ws.length >= 3 && ws.filter((w) => asked.has(w)).length / ws.length >= MAX_POINT_OVERLAP)
				problems.push(`gives away the must-have point "${point}"`)
		}
	} else {
		const { options, answerIndex, whyWrong } = q.content
		if (options.length !== 4) problems.push('multiple choice needs exactly 4 options')
		if (options.some((o) => /\b(all|none|both) of the (above|options)\b/i.test(o))) problems.push('uses "all/none of the above"')
		const lengths = options.map((o) => o.length)
		const right = lengths[answerIndex] ?? 0
		const longestWrong = Math.max(...lengths.filter((_, i) => i !== answerIndex))
		if (right > longestWrong * 1.5 && right - longestWrong > 15) problems.push('the right option is clearly the longest')
		if (Math.max(...lengths) > Math.min(...lengths) * 3 && Math.max(...lengths) > 30) problems.push('option lengths differ too much')
		if (whyWrong.filter((w, i) => i !== answerIndex && w.trim()).length < options.length - 1)
			problems.push('needs a reason why each wrong option is wrong')
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

/** At least this share of a set of questions must go beyond recall. */
export const MIN_ABOVE_RECALL = 0.6
