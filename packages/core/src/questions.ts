import { z } from 'zod'
import type { Rating } from './scheduler'

/** How many questions to write for each section, chosen per item when it is added. */
export const QUESTION_INTENSITIES = ['quick', 'standard', 'thorough'] as const
export type QuestionIntensity = (typeof QUESTION_INTENSITIES)[number]

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
}

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
	grade(content: z.infer<C>, response: z.infer<R>, judge: Judge): Promise<Grade>
}

const def = <C extends z.ZodType, R extends z.ZodType, P>(d: QuestionTypeDef<C, R, P>) => d

export function ratingForScore(score: JudgeVerdict['score']): Rating {
	return score <= 1 ? 'again' : score === 2 ? 'hard' : score === 3 ? 'good' : 'easy'
}

export const questionTypes = {
	short_answer: def({
		content: z.object({
			prompt: z.string().min(1),
			reference: z.string().min(1),
			mustHave: z.array(z.string().min(1)).max(6).default([]),
			niceToHave: z.array(z.string().min(1)).default([]),
			misconceptions: z.array(z.string().min(1)).default([]),
		}),
		response: z.union([z.object({ answer: z.string().trim().min(1).max(4000) }), z.object({ skipped: z.literal(true) })]),
		toPrompt: ({ prompt }) => ({ prompt }),
		async grade(c, r, judge) {
			// "I don't know" is an honest miss; there is nothing for the judge to read.
			if ('skipped' in r)
				return { rating: 'again', correct: false, reveal: { reference: c.reference, mustHave: c.mustHave, score: 0, feedback: '' } }
			// Questions written before checklists existed are graded against their reference answer as one point.
			const mustHave = c.mustHave.length ? c.mustHave : [c.reference]
			const verdict = await judge({ question: c.prompt, reference: c.reference, mustHave, misconceptions: c.misconceptions, answer: r.answer })
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
				},
			}
		},
	}),
	mcq: def({
		content: z
			.object({
				prompt: z.string().min(1),
				options: z.array(z.string().min(1)).min(2).max(6),
				answerIndex: z.number().int().min(0),
				explanation: z.string().default(''),
				/** Why each option is wrong, aligned with `options`; empty for the right one. */
				whyWrong: z.array(z.string()).default([]),
			})
			.refine((c) => c.answerIndex < c.options.length, 'answerIndex out of range'),
		response: z.object({ choice: z.number().int().min(0) }),
		toPrompt: ({ prompt, options }) => ({ prompt, options }),
		async grade(c, r) {
			const correct = r.choice === c.answerIndex
			return {
				rating: correct ? 'good' : 'again',
				correct,
				reveal: { answerIndex: c.answerIndex, explanation: c.explanation, whyWrong: c.whyWrong[r.choice] ?? '' },
			}
		},
	}),
} satisfies Record<string, QuestionTypeDef<z.ZodType, z.ZodType, unknown>>

export type QuestionType = keyof typeof questionTypes
export const QUESTION_TYPES = Object.keys(questionTypes) as QuestionType[]

export type QuestionPrompt = {
	[K in QuestionType]: { type: K; prompt: ReturnType<(typeof questionTypes)[K]['toPrompt']> }
}[QuestionType]

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
