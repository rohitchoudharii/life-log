import { z } from 'zod'
import type { Rating } from './scheduler'

/** How many questions to write for each section, chosen when a quiz is made. */
export const QUESTION_INTENSITIES = ['quick', 'standard', 'thorough'] as const
export type QuestionIntensity = (typeof QUESTION_INTENSITIES)[number]

const PER_QUESTION_WORDS: Record<QuestionIntensity, number> = { quick: 150, standard: 70, thorough: 35 }
const LIMITS: Record<QuestionIntensity, [min: number, max: number]> = { quick: [1, 3], standard: [2, 8], thorough: [3, 20] }

/** How many questions a section gets: more for longer sections and higher intensity. */
export function questionCountFor(wordCount: number, intensity: QuestionIntensity) {
	if (wordCount === 0) return 0
	const [min, max] = LIMITS[intensity]
	return Math.max(min, Math.min(max, Math.round(wordCount / PER_QUESTION_WORDS[intensity])))
}

/** Which kinds of question to write: written answers, multiple choice, or both. */
export const QUESTION_STYLES = ['mixed', 'written', 'choice'] as const
export type QuestionStyle = (typeof QUESTION_STYLES)[number]

/** The kind of thinking a question asks for, from least to most demanding. */
export const QUESTION_LEVELS = ['recall', 'explain', 'apply', 'analyze', 'transfer'] as const
export type QuestionLevel = (typeof QUESTION_LEVELS)[number]

/** What a judge needs to grade a free-form answer, and what it returns. */
export type JudgeInput = {
	question: string
	reference: string
	/** The points a complete answer must make. */
	mustHave: string[]
	misconceptions: string[]
	answer: string
}
/** How well the answer made one must-have point. */
export type PointStatus = 'covered' | 'vague' | 'missing'
export type JudgeVerdict = {
	/** 0 = blank or wrong, 1 = one point or a misconception, 2 = about half, 3 = all with one vague, 4 = all, precisely. */
	score: 0 | 1 | 2 | 3 | 4
	feedback: string
	/** One status per must-have point, in order, when the judge graded against a checklist. */
	points?: PointStatus[]
	/** The misconception the answer stated, if any. */
	misconception?: string | null
	/** Exact phrases from the answer that are right or wrong, to mark in the learner's own words. */
	marks?: AnswerMark[]
}
export type AnswerMark = { quote: string; right: boolean }

/**
 * Turns the judge's per-point verdicts into a score. The judge only says what the answer covered;
 * how strict that makes the grade is decided here, so it is the same for every model.
 */
export function scoreRubric(points: PointStatus[], misconception: boolean): JudgeVerdict['score'] {
	const n = points.length
	const covered = points.filter((p) => p === 'covered').length
	const vague = points.filter((p) => p === 'vague').length
	let score: JudgeVerdict['score']
	if (n > 0 && covered === n) score = 4
	else if (n > 0 && covered + vague === n && vague === 1) score = 3
	else if (n > 0 && covered + vague / 2 >= n / 2) score = 2
	else if (covered + vague > 0) score = 1
	else score = 0
	return misconception ? (Math.min(score, 1) as JudgeVerdict['score']) : score
}
export type Judge = (input: JudgeInput) => Promise<JudgeVerdict>

export type Grade = {
	rating: Rating
	correct: boolean
	/** Shown after answering: the answer key, the judge's feedback, and so on. */
	reveal: Record<string, unknown>
}

/**
 * A question type owns the shape of its stored content, what the client may see before
 * answering, the response it accepts, and how that response is graded. Deterministic types
 * carry their own answer key; judged types ask the LLM judge. Add a type (cloze,
 * match_columns, ...) by adding an entry here and a renderer in the app.
 */
type QuestionTypeDef<C extends z.ZodType, R extends z.ZodType, P> = {
	content: C
	response: R
	/** Content safe to show before the user answers (no answer key). */
	toPrompt(content: z.infer<C>): P
	/** Shows options or steps that could hint at other answers, so it goes after written questions. */
	showsChoices?: boolean
	grade(content: z.infer<C>, response: z.infer<R>, judge: Judge): Promise<Grade>
}

const def = <C extends z.ZodType, R extends z.ZodType, P>(d: QuestionTypeDef<C, R, P>) => d

export function ratingForScore(score: JudgeVerdict['score']): Rating {
	return score <= 1 ? 'again' : score === 2 ? 'hard' : score === 3 ? 'good' : 'easy'
}

/** Every question has a prompt; code it is about goes in its own field, shown as code. */
const stem = { prompt: z.string().min(1), code: z.string().min(1).optional() }
const stemOf = ({ prompt, code }: { prompt: string; code?: string }) => ({ prompt, code })
const judged = {
	...stem,
	reference: z.string().min(1),
	mustHave: z.array(z.string().min(1)).max(6).default([]),
	niceToHave: z.array(z.string().min(1)).default([]),
	misconceptions: z.array(z.string().min(1)).default([]),
}
type Judged = { prompt: string; code?: string; reference: string; mustHave: string[]; misconceptions: string[] }
const written = z.union([z.object({ answer: z.string().trim().min(1).max(4000) }), z.object({ skipped: z.literal(true) })])
const withCode = (c: { prompt: string; code?: string }) => (c.code ? `${c.prompt}\n\n${c.code}` : c.prompt)

/** Grades a written answer against its must-have points with the judge. */
async function gradeWritten(c: Judged, r: z.infer<typeof written>, judge: Judge): Promise<Grade> {
	// "I don't know" is an honest miss; there is nothing for the judge to read.
	if ('skipped' in r) return { rating: 'again', correct: false, reveal: { reference: c.reference, mustHave: c.mustHave, score: 0, feedback: '' } }
	// Questions written before checklists existed are graded against their reference answer as one point.
	const mustHave = c.mustHave.length ? c.mustHave : [c.reference]
	const verdict = await judge({ question: withCode(c), reference: c.reference, mustHave, misconceptions: c.misconceptions, answer: r.answer })
	return {
		rating: ratingForScore(verdict.score),
		correct: verdict.score >= 3,
		reveal: {
			reference: c.reference,
			score: verdict.score,
			feedback: verdict.feedback,
			mustHave: c.mustHave,
			points: c.mustHave.length ? verdict.points : undefined,
			misconception: verdict.misconception ?? null,
			marks: verdict.marks ?? [],
		},
	}
}

/**
 * Reads the number at the start of an answer, so "12.5 ms", "1,024", "-3e-4" and "3/4" all work;
 * whatever follows the number, such as a unit, is ignored. Returns null when the answer does not start with a number.
 */
export function parseNumber(text: string): number | null {
	const m = text
		.replace(/(\d),(?=\d{3}\b)/g, '$1')
		.trim()
		.match(/^([-+−]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)(?:\s*\/\s*((?:\d+\.?\d*|\.\d+)))?/i)
	if (!m) return null
	let n = Number(m[1]!.replace('−', '-'))
	if (m[2] !== undefined) n /= Number(m[2])
	return Number.isFinite(n) ? n : null
}

/** Program output compared the way a person reads it: spacing within and around lines does not count. */
export const normalizeOutput = (text: string) =>
	text
		.replace(/\r\n?/g, '\n')
		.split('\n')
		.map((l) => l.replace(/\s+/g, ' ').trim())
		.join('\n')
		.replace(/^\n+|\n+$/g, '')

const isPermutation = (xs: number[], n: number) => xs.length === n && new Set(xs).size === n && xs.every((x) => Number.isInteger(x) && x >= 0 && x < n)

/** The share of step pairs the learner put in the right relative order: 1 is fully right. */
export function pairsInOrder(order: number[]) {
	let right = 0
	let total = 0
	for (let i = 0; i < order.length; i++)
		for (let j = i + 1; j < order.length; j++) {
			total++
			if (order[i]! < order[j]!) right++
		}
	return total ? right / total : 1
}

type OrderSteps = { steps: string[]; shown?: number[] }
/** Questions stored before their order was set are shown reversed, never in the right order. */
const shownOrder = (c: OrderSteps) => c.shown ?? c.steps.map((_, i) => c.steps.length - 1 - i)

/** Picks the order steps are shown in: shuffled, and never already right. */
export function shuffleSteps<C extends OrderSteps>(c: C, random = Math.random): C & { shown: number[] } {
	const order = c.steps.map((_, i) => i)
	for (let i = order.length - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1))
		;[order[i], order[j]] = [order[j]!, order[i]!]
	}
	if (order.every((x, i) => x === i)) order.push(order.shift()!)
	return { ...c, shown: order }
}

/** A word met while reading: the form it appeared in, the sentence, and its meaning there. */
const wordContent = z.object({ word: z.string().min(1), form: z.string().min(1), sentence: z.string().min(1), meaning: z.string().min(1) })
type WordContent = z.infer<typeof wordContent>
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** The sentence with the word's first appearance blanked out. */
const blank = (c: WordContent) => c.sentence.replace(new RegExp(escapeRegExp(c.form), 'i'), '_____')
const bare = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

function editDistance(a: string, b: string) {
	const row = Array.from({ length: b.length + 1 }, (_, j) => j)
	for (let i = 1; i <= a.length; i++) {
		let prev = row[0]!
		row[0] = i
		for (let j = 1; j <= b.length; j++) {
			const next = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
			prev = row[j]!
			row[j] = next
		}
	}
	return row[b.length]!
}

/** The missing word, ignoring case and punctuation, with one typo allowed in longer words. */
export function isSameWord(answer: string, c: Pick<WordContent, 'word' | 'form'>) {
	const a = bare(answer)
	return [c.form, c.word].some((w) => {
		const x = bare(w)
		return a === x || (x.length >= 6 && editDistance(a, x) <= 1)
	})
}

const wordReveal = (c: WordContent) => ({ word: c.word, sentence: c.sentence, meaning: c.meaning })

export const questionTypes = {
	short_answer: def({
		content: z.object(judged),
		response: written,
		toPrompt: stemOf,
		grade: gradeWritten,
	}),
	mcq: def({
		content: z
			.object({
				...stem,
				options: z.array(z.string().min(1)).min(2).max(6),
				answerIndex: z.number().int().min(0),
				explanation: z.string().default(''),
				/** Why each option is wrong, aligned with `options`; empty for the right one. */
				whyWrong: z.array(z.string()).default([]),
			})
			.refine((c) => c.answerIndex < c.options.length, 'answerIndex out of range'),
		response: z.object({ choice: z.number().int().min(0) }),
		showsChoices: true,
		toPrompt: ({ prompt, code, options }) => ({ prompt, code, options }),
		async grade(c, r) {
			const correct = r.choice === c.answerIndex
			return {
				rating: correct ? 'good' : 'again',
				correct,
				reveal: { answerIndex: c.answerIndex, explanation: c.explanation, whyWrong: c.whyWrong[r.choice] ?? '' },
			}
		},
	}),
	/** A problem with a numeric answer. The number is checked exactly; the working, when given, against the key steps. */
	worked_problem: def({
		content: z.object({
			...stem,
			answer: z.number().finite(),
			/** How far from `answer` still counts as right, in the same unit. */
			tolerance: z.number().min(0).default(0),
			unit: z.string().default(''),
			/** The worked solution, shown afterwards. */
			solution: z.string().min(1),
			/** The steps a correct working takes, used to grade the working. */
			steps: z.array(z.string().min(1)).max(6).default([]),
			misconceptions: z.array(z.string().min(1)).default([]),
		}),
		response: z.union([
			z.object({ value: z.string().trim().min(1).max(200), working: z.string().trim().max(4000).optional() }),
			z.object({ skipped: z.literal(true) }),
		]),
		toPrompt: ({ prompt, code, unit }) => ({ prompt, code, unit }),
		async grade(c, r, judge) {
			const key = { answer: c.answer, unit: c.unit, solution: c.solution, steps: c.steps }
			if ('skipped' in r) return { rating: 'again', correct: false, reveal: key }
			const given = parseNumber(r.value)
			// A tiny relative margin absorbs floating-point rounding in the key itself.
			const correct = given !== null && Math.abs(given - c.answer) <= Math.max(c.tolerance, Math.abs(c.answer) * 1e-9)
			let verdict: JudgeVerdict | null = null
			if (r.working && c.steps.length)
				verdict = await judge({
					question: withCode(c),
					reference: c.solution,
					mustHave: c.steps,
					misconceptions: c.misconceptions,
					answer: `Final answer: ${r.value}\nWorking:\n${r.working}`,
				})
			return {
				// The number decides whether it was right; clean working on a right answer makes it easy.
				rating: correct ? (verdict?.score === 4 ? 'easy' : 'good') : 'again',
				correct,
				reveal: {
					...key,
					given,
					feedback: verdict?.feedback ?? '',
					points: verdict?.points,
					misconception: verdict?.misconception ?? null,
				},
			}
		},
	}),
	/** Code to run in the head: the learner writes what it prints. */
	predict_output: def({
		content: z.object({ prompt: z.string().min(1), code: z.string().min(1), output: z.string().min(1), explanation: z.string().default('') }),
		response: z.union([z.object({ output: z.string().max(4000) }), z.object({ skipped: z.literal(true) })]),
		toPrompt: stemOf,
		async grade(c, r) {
			const correct = !('skipped' in r) && normalizeOutput(r.output) === normalizeOutput(c.output)
			return { rating: correct ? 'good' : 'again', correct, reveal: { output: c.output, explanation: c.explanation } }
		},
	}),
	/** A flawed claim or piece of code: the learner says what is wrong and why. */
	find_error: def({
		content: z.object(judged),
		response: written,
		toPrompt: stemOf,
		grade: gradeWritten,
	}),
	/** Steps of a process, shown shuffled, to be put in order. */
	order_steps: def({
		content: z
			.object({
				...stem,
				/** In the right order. */
				steps: z.array(z.string().min(1)).min(3).max(8),
				/** The order they are shown in, as indexes into `steps`; set when the question is stored. */
				shown: z.array(z.number().int()).optional(),
				explanation: z.string().default(''),
			})
			.refine((c) => !c.shown || isPermutation(c.shown, c.steps.length), 'shown is not an order of the steps'),
		/** Positions in the shown list, in the order the learner put them. */
		response: z.object({ order: z.array(z.number().int().min(0)).max(8) }),
		showsChoices: true,
		toPrompt: (c) => ({ prompt: c.prompt, code: c.code, steps: shownOrder(c).map((i) => c.steps[i]!) }),
		async grade(c, r) {
			const shown = shownOrder(c)
			if (!isPermutation(r.order, shown.length))
				throw new z.ZodError([{ code: 'custom', path: ['order'], message: 'Put every step in order once', input: r.order }])
			const pairs = pairsInOrder(r.order.map((k) => shown[k]!))
			const correct = pairs === 1
			// Partial credit: one pair swapped in a long list is close, but still not right.
			return { rating: correct ? 'good' : pairs >= 0.8 ? 'hard' : 'again', correct, reveal: { steps: c.steps, explanation: c.explanation, pairs } }
		},
	}),
	/** Vocabulary, easiest first: fill the word back into its sentence. */
	word_cloze: def({
		content: wordContent,
		response: written,
		toPrompt: (c) => ({ prompt: 'Which word fills the blank?', sentence: blank(c), hint: `Starts with "${c.form[0]}", ${c.form.length} letters` }),
		async grade(c, r) {
			const correct = !('skipped' in r) && isSameWord(r.answer, c)
			return { rating: correct ? 'good' : 'again', correct, reveal: wordReveal(c) }
		},
	}),
	/** Vocabulary: what the word means in the sentence it was met in. */
	word_meaning: def({
		content: wordContent,
		response: written,
		toPrompt: (c) => ({ prompt: `What does "${c.form}" mean here?`, sentence: c.sentence }),
		grade: (c, r, judge) =>
			gradeWritten({ prompt: `What does "${c.form}" mean in this sentence? ${c.sentence}`, reference: c.meaning, mustHave: [c.meaning], misconceptions: [] }, r, judge).then((g) => ({
				...g,
				reveal: { ...g.reveal, ...wordReveal(c) },
			})),
	}),
	/** Vocabulary, hardest: use the word in a sentence of one's own. */
	word_use: def({
		content: wordContent,
		response: written,
		toPrompt: (c) => ({ prompt: `Use "${c.word}" in a sentence of your own, with the meaning it has here.`, sentence: c.sentence }),
		grade: (c, r, judge) =>
			gradeWritten(
				{
					prompt: `Use "${c.word}" in a new sentence, with the meaning it has in: ${c.sentence}`,
					reference: `A sentence that uses "${c.word}" to mean: ${c.meaning}`,
					mustHave: [`Uses "${c.word}" (or a form of it) correctly, with the meaning: ${c.meaning}`, 'Is a new sentence of the learner\'s own, not the one shown or a near copy of it'],
					misconceptions: [],
				},
				r,
				judge,
			).then((g) => ({ ...g, reveal: { ...g.reveal, ...wordReveal(c) } })),
	}),
} satisfies Record<string, QuestionTypeDef<z.ZodType, z.ZodType, unknown>>

export type QuestionType = keyof typeof questionTypes

/** A word's test at each level of its schedule: recognise it, then say what it means, then use it. */
export const WORD_TESTS = ['word_cloze', 'word_meaning', 'word_use'] as const satisfies QuestionType[]
export const wordTestFor = (level: number) => WORD_TESTS[Math.min(Math.max(level, 0), WORD_TESTS.length - 1)]!
export const QUESTION_TYPES = Object.keys(questionTypes) as QuestionType[]

export type QuestionPrompt = {
	[K in QuestionType]: { type: K; prompt: ReturnType<(typeof questionTypes)[K]['toPrompt']> }
}[QuestionType]

/** Types that show options or steps, which could hint at other answers. */
export const showsChoices = (type: QuestionType) => Boolean((questionTypes[type] as { showsChoices?: boolean }).showsChoices)

export function isQuestionType(type: string): type is QuestionType {
	return Object.hasOwn(questionTypes, type)
}

/** Validates content coming from the LLM. Returns null when it does not fit the type. */
export function parseQuestionContent(type: string, content: unknown): unknown | null {
	if (!isQuestionType(type)) return null
	const parsed = questionTypes[type].content.safeParse(content)
	return parsed.success ? parsed.data : null
}

export function toPrompt(type: QuestionType, content: unknown): QuestionPrompt {
	const t = questionTypes[type] as QuestionTypeDef<z.ZodType, z.ZodType, unknown>
	return { type, prompt: t.toPrompt(content) } as QuestionPrompt
}

/** Grades a response. Throws a ZodError when the response does not fit the type. */
export function gradeResponse(type: QuestionType, content: unknown, response: unknown, judge: Judge): Promise<Grade> {
	const t = questionTypes[type] as QuestionTypeDef<z.ZodType, z.ZodType, unknown>
	return t.grade(content, t.response.parse(response), judge)
}

export type McqContent = z.infer<(typeof questionTypes)['mcq']['content']>

/** Models tend to put the right option first; shuffling in code removes that tell. */
export function shuffleMcq(c: McqContent, random = Math.random): McqContent {
	const order = c.options.map((_, i) => i)
	for (let i = order.length - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1))
		;[order[i], order[j]] = [order[j]!, order[i]!]
	}
	return {
		...c,
		options: order.map((i) => c.options[i]!),
		whyWrong: c.whyWrong.length ? order.map((i) => c.whyWrong[i] ?? '') : [],
		answerIndex: order.indexOf(c.answerIndex),
	}
}

/**
 * Orders a test. Written questions come before ones with options or steps, because seeing them hints at
 * later answers. Within each, questions on ideas the brain dump missed come first, then vague
 * ones, then the rest; order within a group is shuffled so topics mix.
 */
export function orderForTest<Q extends { type: QuestionType; ideaId: string | null }>(
	questions: Q[],
	recall: ReadonlyMap<string, PointStatus>,
	random = Math.random,
): Q[] {
	const rank = (q: Q) => {
		const status = q.ideaId ? recall.get(q.ideaId) : undefined
		const idea = status === 'missing' ? 0 : status === 'vague' ? 1 : 2
		return (showsChoices(q.type) ? 3 : 0) + idea
	}
	return questions
		.map((q) => ({ q, rank: rank(q), r: random() }))
		.sort((a, b) => a.rank - b.rank || a.r - b.r)
		.map(({ q }) => q)
}
