// A small web site that link imports fetch in e2e tests, serving saved real pages from the
// server's import fixtures. The e2e API allows its origin even though it is on this machine.
// Run with Node 26, which strips the types.
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'

const fixture = (name: string) => readFileSync(new URL(`../apps/server/src/import/fixtures/${name}`, import.meta.url))
const html = { 'content-type': 'text/html; charset=utf-8' }

/** A 1,300-word essay with no headings, as many blog posts are. */
const essay = `<html><head><title>Notes on attention</title></head><body><article><h1>Notes on attention</h1>${Array.from(
	{ length: 16 },
	(_, i) => `<p>Paragraph ${i + 1}. ${'Attention is where the mind chooses to spend itself, and what we read with it stays. '.repeat(5)}</p>`,
).join('')}</article></body></html>`

const pages: Record<string, () => { status?: number; headers: Record<string, string>; body?: Buffer | string; delayMs?: number }> = {
	'/health': () => ({ headers: {}, body: 'ok' }),
	'/articles/spaced-repetition': () => ({ headers: html, body: fixture('wikipedia-spaced-repetition.html'), delayMs: 1500 }),
	'/articles/execution-model': () => ({ headers: html, body: fixture('mdn-execution-model.html') }),
	'/articles/no-headings': () => ({ headers: html, body: essay }),
	'/opinions/23-719.pdf': () => ({ headers: { 'content-type': 'application/pdf' }, body: fixture('trump-v-anderson.pdf') }),
	'/members-only': () => ({ status: 302, headers: { location: '/login' } }),
	'/login': () => ({ headers: html, body: '<h1>Sign in</h1><form><input name="email"><input type="password"><button>Sign in</button></form>' }),
	// A public page that redirects to this machine, as an attacker's site might.
	'/to-private': () => ({ status: 302, headers: { location: 'http://127.0.0.1:8788/health' } }),
}

const server = createServer((req, res) => {
	const page = pages[new URL(req.url ?? '/', 'http://x').pathname]?.()
	if (!page) return res.writeHead(404, html).end('<p>Not found</p>')
	setTimeout(() => res.writeHead(page.status ?? 200, page.headers).end(page.body), page.delayMs ?? 0)
})

server.listen(Number(process.env.PORT ?? 8797))
