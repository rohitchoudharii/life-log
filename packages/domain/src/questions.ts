import { z } from 'zod'
import type { Rating } from './scheduler'

/**
 * The kind of thinking a question asks for, from least to most demanding. A card's own cue is
 * the recall level; every stored question is above it.
 */
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
/** How well an answer made one must-have point, or how well a brain dump covered one idea. */
export type PointStatus = 'covered' | 'vague' | 'missing'
export type AnswerMark = { quote: string; right: boolean }
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
export type Judge = (input: JudgeInput) => Promise<JudgeVerdict>

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

/** A score of 0 or 1 is forgotten, 2 is hard, 3 is right and 4 is right and precise. */
export function ratingForScore(score: JudgeVerdict['score']): Rating {
	return score <= 1 ? 'again' : score === 2 ? 'hard' : score === 3 ? 'good' : 'easy'
}

export type Grade = {
	rating: Rating
	/** A score of 3 or more. */
	correct: boolean
	/** Shown after answering: the answer key, the judge's feedback, and so on. */
	reveal: Record<string, unknown>
}

/** How sure the learner said they were as they answered. */
export const CONFIDENCES = ['guessing', 'think_so', 'sure'] as const
export type Confidence = (typeof CONFIDENCES)[number]

/**
 * Confidence only ever lowers credit. A right answer called a guess is spaced like a hard one, so
 * a lucky guess doesn't push its idea far out, and `easy` needs Sure or no confidence at all.
 */
export function withConfidence(grade: Grade, confidence: Confidence | null | undefined): Grade {
	if (grade.correct && confidence === 'guessing') return { ...grade, rating: 'hard' }
	if (grade.rating === 'easy' && confidence === 'think_so') return { ...grade, rating: 'good' }
	return grade
}

/**
 * A question type owns the shape of its stored content, what the learner may see before
 * answering, the response it accepts, and how that response is graded. Add a type by adding an
 * entry here and a renderer in the app.
 */
type QuestionTypeDef<C extends z.ZodType, R extends z.ZodType, P> = {
	content: C
	response: R
	/** Content safe to show before the learner answers (no answer key). */
	toPrompt(content: z.infer<C>): P
	/** Shows options or steps that could hint at other answers, so it goes after written questions. */
	showsChoices?: boolean
	grade(content: z.infer<C>, response: z.infer<R>, judge: Judge): Promise<Grade>
}

const def = <C extends z.ZodType, R extends z.ZodType, P>(d: QuestionTypeDef<C, R, P>) => d

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
export type Judged = { prompt: string; code?: string; reference: string; mustHave: string[]; misconceptions: string[] }
/** A written answer, or "I don't know". */
export const writtenResponse = z.union([z.object({ answer: z.string().trim().min(1).max(4000) }), z.object({ skipped: z.literal(true) })])
export type WrittenResponse = z.infer<typeof writtenResponse>
const withCode = (c: { prompt: string; code?: string }) => (c.code ? `${c.prompt}\n\n${c.code}` : c.prompt)

/** Grades a written answer against its must-have points with the judge. */
export async function gradeWritten(c: Judged, r: WrittenResponse, judge: Judge): Promise<Grade> {
	// "I don't know" is an honest miss; there is nothing for the judge to read.
	if ('skipped' in r) return { rating: 'again', correct: false, reveal: { reference: c.reference, mustHave: c.mustHave, score: 0, feedback: '' } }
	// A question without a checklist is graded against its reference answer as one point.
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

export const questionTypes = {
	short_answer: def({
		content: z.object(judged),
		response: writtenResponse,
		toPrompt: stemOf,
		grade: gradeWritten,
	}),
} satisfies Record<string, QuestionTypeDef<z.ZodType, z.ZodType, unknown>>

export type QuestionType = keyof typeof questionTypes
export const QUESTION_TYPES = Object.keys(questionTypes) as QuestionType[]

export type QuestionPrompt = {
	[K in QuestionType]: { type: K; prompt: ReturnType<(typeof questionTypes)[K]['toPrompt']> }
}[QuestionType]

/** Types that show options or steps, which could hint at other answers. */
export const showsChoices = (type: QuestionType) => Boolean((questionTypes[type] as { showsChoices?: boolean }).showsChoices)

export function isQuestionType(type: string): type is QuestionType {
	return Object.hasOwn(questionTypes, type)
}

/** Validates content coming from the AI. Returns null when it does not fit the type. */
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

/**
 * Orders the questions of a recall check. Written ones come before ones with options or steps,
 * because seeing options hints at later answers. Within each, ideas the dump missed come first,
 * then vague ones, then the rest, shuffled so topics mix. `type` is null for a cue.
 */
export function orderForTest<Q extends { type: QuestionType | null; cardId: string }>(
	questions: Q[],
	marks: ReadonlyMap<string, PointStatus>,
	random = Math.random,
): Q[] {
	const rank = (q: Q) => {
		const mark = marks.get(q.cardId)
		return (q.type && showsChoices(q.type) ? 3 : 0) + (mark === 'missing' ? 0 : mark === 'vague' ? 1 : 2)
	}
	return questions
		.map((q) => ({ q, rank: rank(q), r: random() }))
		.sort((a, b) => a.rank - b.rank || a.r - b.r)
		.map(({ q }) => q)
}
