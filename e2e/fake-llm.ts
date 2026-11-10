// A stand-in for the Anthropic and OpenAI APIs, so tests never call the real providers or need
// a real key. It lists models and answers completions, picking a canned reply by the prompt's
// first line ("Task: …"). Run with Node 26, which strips the types.
import { createServer, type IncomingMessage } from 'node:http'

const GOOD_ANTHROPIC_KEY = process.env.GOOD_ANTHROPIC_KEY
const GOOD_OPENAI_KEY = process.env.GOOD_OPENAI_KEY

const readJson = async (req: IncomingMessage) => {
	let text = ''
	for await (const chunk of req) text += chunk
	return JSON.parse(text)
}

/** Headings before the first block and halfway through, for the "Task: headings" prompt. */
function headings(user: string) {
	const blocks = user.match(/^\[\d+\]/gm)?.length ?? 0
	return { headings: [{ before: 1, title: 'How it starts', level: 2 }, { before: Math.floor(blocks / 2) + 1, title: 'Where it leads', level: 2 }] }
}

/** The sections in a prompt, by the number the prompt gives them. */
const sectionsIn = (user: string) => [...user.matchAll(/<section number="(\d+)"[^>]*>\n([\s\S]*?)\n<\/section>/g)].map((m) => ({ n: Number(m[1]), text: m[2]! }))

/** Plain sentences of at least 6 words, not code, to stand in for what a section teaches. */
const sentences = (text: string) =>
	(text.match(/[A-Z][^.!?\n]*[.!?]/g) ?? []).map((x) => x.trim()).filter((x) => x.split(/\s+/).length >= 6 && !/[{}();=<>`]/.test(x))

/**
 * Up to three key ideas per section for "Task: write-section", each resting on a real sentence of
 * the section, with one question each, plus one idea whose quote is in no section, which the
 * app must drop.
 */
/** A multiple-choice question on point `k`, the right option first, as models tend to write it. */
const mcqOn = (k: number, quote: string) => ({
	type: 'mcq',
	level: 'apply',
	content: {
		prompt: `Which reading of point ${k} of this part holds up?`,
		options: ['It holds as the text states it.', 'It holds only on some days.', 'It holds for experts alone.', 'It never holds in practice.'],
		answerIndex: 0,
		explanation: `The text states it plainly: ${quote}`,
		whyWrong: ['', 'The text sets no such limit on when.', 'The text says it holds for anyone.', 'The text shows it holding.'],
	},
})

/** Key ideas from the first sentences of each section; multiple choice when the member asks for choice only. */
function writeSection(system: string, user: string) {
	const choice = system.includes('Only these types, picked from the content: mcq, order_steps.')
	const ideas = sectionsIn(user).flatMap(({ n, text }) =>
		sentences(text)
			.slice(0, 3)
			.map((quote, k) => {
				const words = quote.split(/\s+/)
				const half = Math.ceil(words.length / 2)
				return {
					section: n,
					rank: k + 1,
					idea: quote,
					cue: `Which point number ${k + 1} did this part make?`,
					quote,
					questions: [
						choice ? mcqOn(k + 1, quote) : {
							type: 'short_answer',
							level: 'explain',
							content: {
								prompt: `Why does point ${k + 1} of this part matter to someone new to the topic?`,
								reference: `${quote} That is why it matters.`,
								mustHave: [words.slice(0, half).join(' '), words.slice(half).join(' ')],
								misconceptions: [],
							},
						},
					],
				}
			}),
	)
	if (ideas[0]) ideas.push({ ...ideas[0], rank: 99, idea: 'An idea the text never states.', quote: 'This sentence appears nowhere in the section at all.' })
	return { ideas }
}

/**
 * For "Task: rewrite-questions": one fresh question for each request, on the idea it names,
 * multiple choice when the member asks for choice only.
 */
function rewriteQuestions(system: string, user: string) {
	const list = JSON.parse(user.slice(user.lastIndexOf('\n[') + 1)) as { id: number; idea: string }[]
	return {
		questions: list.map(({ id, idea }) => {
			if (system.includes('Only these types, picked from the content: mcq, order_steps.')) return { id, ...mcqOn(id, idea) }
			const words = idea.split(/\s+/)
			const half = Math.ceil(words.length / 2)
			return {
				id,
				type: 'short_answer',
				level: 'apply',
				content: {
					// Two templates, so an idea's two questions in Thorough are not the same question.
					prompt: id % 2 ? `How would idea ${id} of this part change what a newcomer does next?` : `What would go wrong for a beginner who ignored idea ${id} of this part?`,
					reference: `${idea} So the newcomer acts on it.`,
					mustHave: [words.slice(0, half).join(' '), words.slice(half).join(' ')],
					misconceptions: [],
				},
			}
		}),
	}
}

/** Keeps every question for "Task: check-questions". */
const checkQuestions = (user: string) => ({ checks: [...user.matchAll(/"id": (\d+)/g)].map((m) => ({ id: Number(m[1]), verdict: 'keep' })) })

const longWords = (text: string) => [...new Set(text.toLowerCase().match(/[a-z]{5,}/g) ?? [])]

/**
 * Marks each idea for "Task: grade-recall" by the long words the dump shares with it: most of
 * them is covered, two or more is vague, fewer is missing. A test picks a mark by what it types.
 */
function gradeRecall(user: string) {
	const ideas = [...(user.split('<dump>')[0] ?? '').matchAll(/^\d+\. (.+)$/gm)].map((m) => m[1]!)
	const dump = new Set(longWords(user.split('<dump>')[1] ?? ''))
	const marks = ideas.map((idea) => {
		const words = longWords(idea)
		const shared = words.filter((w) => dump.has(w)).length
		return shared >= Math.max(2, words.length * 0.6) ? 'covered' : shared >= 2 ? 'vague' : 'missing'
	})
	return { ideas: marks, feedback: 'You brought back the main point. Look again at what you missed.' }
}

/**
 * Marks each must-have point for "Task: judge-answer" by the long words the answer shares with
 * it: most of them is covered, one or more is vague, none is missing. A test picks a verdict by
 * what it types.
 */
function judgeAnswer(user: string) {
	const points = [...(user.split('Must-have points:')[1]?.split('Known misconceptions:')[0] ?? '').matchAll(/^\d+\. (.+)$/gm)].map((m) => m[1]!)
	const given = new Set(longWords(user.split('<answer>')[1] ?? ''))
	const marks = points.map((point) => {
		const words = longWords(point)
		const shared = words.filter((w) => given.has(w)).length
		return shared >= Math.max(1, words.length * 0.6) ? 'covered' : shared >= 1 ? 'vague' : 'missing'
	})
	const feedback = marks.every((m) => m === 'covered') ? 'You made the main point clearly.' : 'Part of the point is missing. Look at the model answer.'
	return { points: marks, misconception: null, feedback, marks: [] }
}

/**
 * For "Task: explain-passage": an explanation of the kind asked for, about the selected passage,
 * resting on the section's first sentence. A worked example comes with code.
 */
function explainPassage(user: string) {
	const passage = user.split('<passage>\n')[1]?.split('\n</passage>')[0] ?? ''
	const quote = sentences(user.split('<section>\n')[1]?.split('\n</section>')[0] ?? '')[0] ?? ''
	if (user.includes('one analogy from everyday life'))
		return { text: `Think of a kitchen: the cook and the stove each do their part. That is how "${passage}" works. The analogy breaks down because a kitchen has no rules written down.`, quote }
	if (user.includes('one concrete example'))
		return { text: 'Here is the idea at work, step by step. The first line sets a value, the second uses it.', code: 'let gap = 1\nconsole.log(gap * 2)', quote }
	return { text: `From first principles: "${passage}" holds because each part rests on the cause underneath it. Start from that cause and the rest follows.`, quote }
}

function answer(system: string, user: string) {
	if (system.startsWith('Task: explain-passage')) return JSON.stringify(explainPassage(user))
	if (system.startsWith('Task: judge-answer')) return JSON.stringify(judgeAnswer(user))
	if (system.startsWith('Task: grade-recall')) return JSON.stringify(gradeRecall(user))
	if (system.startsWith('Task: headings')) return JSON.stringify(headings(user))
	if (system.startsWith('Task: write-section')) return JSON.stringify(writeSection(system, user))
	if (system.startsWith('Task: rewrite-questions')) return JSON.stringify(rewriteQuestions(system, user))
	if (system.startsWith('Task: check-questions')) return JSON.stringify(checkQuestions(user))
	if (system.startsWith('Task: lesson-cue')) return JSON.stringify({ cue: 'Where did this lesson come up for you?' })
	if (system.startsWith('Task: write-cue')) return JSON.stringify({ cue: 'What did you want to keep from this part?' })
	return '{}'
}

const server = createServer(async (req, res) => {
	const json = (status: number, body: unknown) => {
		res.writeHead(status, { 'content-type': 'application/json' })
		res.end(JSON.stringify(body))
	}
	if (req.url === '/health') return json(200, { ok: true })
	if (req.method === 'POST' && req.url === '/v1/messages') {
		if (req.headers['x-api-key'] !== GOOD_ANTHROPIC_KEY) return json(401, { error: { message: 'invalid x-api-key' } })
		const body = await readJson(req)
		// Writing takes a moment, as it does for real, so a waiting member sees the waiting line.
		if (body.system.startsWith('Task: write-section')) await new Promise((r) => setTimeout(r, 1500))
		// A test makes Explain fail by selecting this.
		if (body.system.startsWith('Task: explain-passage') && body.messages[0].content.includes('<passage>\nEXPLAIN_FAILS')) return json(500, { error: { message: 'overloaded' } })
		// A test makes the judge fail by writing this in its answer.
		if (body.system.startsWith('Task: judge-answer') && body.messages[0].content.includes('JUDGE_FAILS')) return json(500, { error: { message: 'overloaded' } })
		const text = answer(body.system, body.messages[0].content)
		return json(200, { content: [{ type: 'text', text }], usage: { input_tokens: 1000, output_tokens: 50 } })
	}
	if (req.method === 'POST' && req.url === '/v1/chat/completions') {
		if (req.headers.authorization !== `Bearer ${GOOD_OPENAI_KEY}`) return json(401, { error: { message: 'Incorrect API key provided' } })
		const body = await readJson(req)
		const text = answer(body.messages[0].content, body.messages[1].content)
		return json(200, { choices: [{ message: { content: text } }], usage: { prompt_tokens: 1000, completion_tokens: 50 } })
	}
	if (!req.url?.startsWith('/v1/models')) return json(404, { error: { message: 'not found' } })
	if (req.headers['x-api-key']) {
		if (req.headers['x-api-key'] !== GOOD_ANTHROPIC_KEY) return json(401, { error: { message: 'invalid x-api-key' } })
		return json(200, { data: [{ id: 'claude-sonnet-5-5' }, { id: 'claude-haiku-5-5' }] })
	}
	if (req.headers.authorization !== `Bearer ${GOOD_OPENAI_KEY}`)
		return json(401, { error: { message: 'Incorrect API key provided' } })
	return json(200, {
		data: [
			{ id: 'gpt-6.1-sol', created: 3 },
			{ id: 'gpt-image-2', created: 4 },
			{ id: 'gpt-6.1-terra', created: 2 },
		],
	})
})

server.listen(Number(process.env.PORT ?? 8799))
