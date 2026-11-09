import { readFileSync } from 'node:fs'
import http from 'node:http'
import { gzipSync } from 'node:zlib'

/** The site import tests fetch from. vitest.config.ts allows its origin, which is on this machine. */
export const TEST_SITE = 'http://localhost:8796'

type Page = { body: string | Buffer; headers?: http.OutgoingHttpHeaders; status?: number }

/** A saved page from `fixtures/`, as its site served it. */
export const fixture = (name: string): Page => ({
	body: readFileSync(new URL(`fixtures/${name}`, import.meta.url)),
	headers: { 'content-type': 'text/html; charset=utf-8' },
})

/**
 * A small web server for import tests. It answers `/status/<code>`, `/redirect?to=<url>`, a
 * Cloudflare-style `/challenge`, a gzip bomb at `/bomb`, and any page a test adds with `serve`.
 */
export function testSite() {
	const pages = new Map<string, Page>()
	let hits = new Map<string, number>()
	const server = http.createServer((req, res) => {
		const url = new URL(req.url ?? '/', TEST_SITE)
		hits.set(url.pathname, (hits.get(url.pathname) ?? 0) + 1)
		const page = pages.get(url.pathname)
		if (page) return res.writeHead(page.status ?? 200, page.headers).end(page.body)
		const status = /^\/status\/(\d{3})$/.exec(url.pathname)?.[1]
		if (status) return res.writeHead(Number(status), { 'content-type': 'text/html' }).end('<p>status</p>')
		if (url.pathname === '/redirect') return res.writeHead(302, { location: url.searchParams.get('to') ?? '/' }).end()
		if (url.pathname === '/challenge') return res.writeHead(403, { 'cf-mitigated': 'challenge', 'content-type': 'text/html' }).end('<p>Just a moment…</p>')
		if (url.pathname === '/bomb')
			return res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' }).end(gzipSync(Buffer.alloc(8 * 1024 * 1024, 32)))
		res.writeHead(404).end()
	})
	return {
		start: () => new Promise<void>((resolve) => server.listen(Number(new URL(TEST_SITE).port), resolve)),
		stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
		/** Serves `page` at `path` until the site stops. */
		serve(path: string, page: Page) {
			pages.set(path, page)
			return `${TEST_SITE}${path}`
		},
		/** How many times each path was fetched since the last call. */
		takeHits() {
			const taken = hits
			hits = new Map()
			return taken
		},
	}
}
