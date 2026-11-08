// A stand-in for the Anthropic and OpenAI model lists, so tests never call the real providers
// or need a real key. Run with Node 26, which strips the types.
import { createServer } from 'node:http'

const GOOD_ANTHROPIC_KEY = process.env.GOOD_ANTHROPIC_KEY
const GOOD_OPENAI_KEY = process.env.GOOD_OPENAI_KEY

const server = createServer((req, res) => {
	const json = (status: number, body: unknown) => {
		res.writeHead(status, { 'content-type': 'application/json' })
		res.end(JSON.stringify(body))
	}
	if (req.url === '/health') return json(200, { ok: true })
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
