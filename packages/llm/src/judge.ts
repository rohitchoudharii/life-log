import { scoreRubric, type AnswerMark, type JudgeInput, type JudgeVerdict, type PointStatus } from '@life-log-club/core'
import { extractJson } from './generate'
import type { LlmProvider } from './providers'

const SYSTEM = `You grade a learner's answer during retrieval practice, like a strict but fair examiner. You do not give a score; you say which required points the answer made.

For each must-have point, decide:
- "covered": the answer states the point, with its reasoning where the point has one. Own words, analogies, and a different order are fine.
- "vague": the answer gestures at the point but is imprecise, incomplete, or only names the right term.
- "missing": the point is absent or wrong.

Be strict:
- Repeating or rephrasing the question earns nothing.
- Naming a key term without saying what it does or why is "vague" at best.
- Do not give credit for points the answer does not make, however likely the learner knows them.
- Ignore spelling and grammar.

If the answer states one of the listed misconceptions, or another clear factual error, name it in "misconception"; otherwise null.

Feedback: 1 to 3 short sentences to the learner as "you". Name what they got, then exactly what was missing or wrong, and why, from the underlying cause or mechanism, so they can rebuild the point next time. Correct any misconception.

Write the feedback as plain text: no Markdown, no backticks.

Marks: the phrases in the answer that made a point ("right": true) and the phrases that are factually wrong ("right": false), so the learner sees them in their own words. Copy each "quote" exactly from the answer, character for character, a clause or sentence long, never the whole answer. Leave out phrases that are neither. Use [] when nothing stands out.

Reply with JSON only: {"points": ["covered" | "vague" | "missing", …one per must-have point, in order], "misconception": string | null, "feedback": "…", "marks": [{"quote": "…", "right": true | false}, …]}`

const STATUSES: PointStatus[] = ['covered', 'vague', 'missing']

/** Grades one free-form answer against its must-have points; the score is computed from them, not taken from the model. */
export async function judgeAnswer(provider: LlmProvider, apiKey: string, model: string, input: JudgeInput): Promise<JudgeVerdict> {
	const raw = await provider.complete(apiKey, {
		model,
		system: SYSTEM,
		user: `Question: ${input.question}

Must-have points:
${input.mustHave.map((p, i) => `${i + 1}. ${p}`).join('\n')}

Known misconceptions:
${input.misconceptions.length ? input.misconceptions.map((m) => `- ${m}`).join('\n') : '- none listed'}

Model answer: ${input.reference}

Learner's answer:
"""
${input.answer}
"""`,
		json: true,
		maxTokens: 1000,
	})
	const parsed = extractJson(raw) as { points?: unknown; misconception?: unknown; feedback?: unknown; marks?: unknown }
	if (!Array.isArray(parsed.points)) throw new Error('The model did not grade the points')
	// A missing or unreadable verdict for a point counts against the answer, never for it.
	const points = input.mustHave.map((_, i) => {
		const p = parsed.points as unknown[]
		return STATUSES.includes(p[i] as PointStatus) ? (p[i] as PointStatus) : 'missing'
	})
	const misconception = typeof parsed.misconception === 'string' && parsed.misconception.trim() ? parsed.misconception.trim() : null
	return {
		score: scoreRubric(points, misconception !== null),
		points,
		misconception,
		feedback: typeof parsed.feedback === 'string' ? parsed.feedback.trim() : '',
		// A quote the answer does not contain cannot be marked, so it is dropped rather than shown out of place.
		marks: (Array.isArray(parsed.marks) ? (parsed.marks as { quote?: unknown; right?: unknown }[]) : [])
			.filter((m): m is AnswerMark => typeof m?.quote === 'string' && m.quote.trim() !== '' && typeof m.right === 'boolean')
			.map((m) => ({ quote: m.quote.trim(), right: m.right }))
			.filter((m) => input.answer.includes(m.quote)),
	}
}
