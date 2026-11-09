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
function writeSection(user: string) {
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
						{
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

function answer(system: string, user: string) {
	if (system.startsWith('Task: grade-recall')) return JSON.stringify(gradeRecall(user))
	if (system.startsWith('Task: headings')) return JSON.stringify(headings(user))
	if (system.startsWith('Task: write-section')) return JSON.stringify(writeSection(user))
	if (system.startsWith('Task: check-questions')) return JSON.stringify(checkQuestions(user))
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
