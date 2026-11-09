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

function answer(system: string, user: string) {
	if (system.startsWith('Task: headings')) return JSON.stringify(headings(user))
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
