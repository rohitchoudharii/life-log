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

/**
 * A web book with one page per chapter, as mdBook or Sphinx write them: a contents page at
 * `/books/rings/` and 22 chapter pages, one more than the import job fetches in one run. Chapter 7
 * is missing (404). The same book under `/books/private/` is one robots.txt asks apps not to copy.
 */
const CHAPTERS = [
	'Why rings',
	'Hashing keys',
	'Placing servers',
	'Virtual nodes',
	'Adding a server',
	'Removing a server',
	'Replication',
	'Hot spots',
	'Bounded loads',
	'Rendezvous hashing',
	'Jump hashing',
	'Maglev',
	'Membership',
	'Gossip',
	'Failure detection',
	'Read repair',
	'Hinted handoff',
	'Anti-entropy',
	'Merkle trees',
	'Operating a ring',
	'Measuring balance',
	'What to read next',
]
const contents = (dir: string) =>
	`<!doctype html><html><head><title>Contents · The Ring Book</title></head><body><h1>The Ring Book</h1><h2>Contents</h2><ol class="toc">${CHAPTERS.map(
		(title, i) => `<li><a href="/books/${dir}/${i + 1}.html">${i + 1}. ${title}</a></li>`,
	).join('')}</ol></body></html>`
const chapter = (n: number) =>
	`<!doctype html><html><head><title>${n}. ${CHAPTERS[n - 1]} · The Ring Book</title></head><body><nav><a href="/books/rings/">Contents</a></nav><article><h1>${n}. ${CHAPTERS[n - 1]}</h1>${Array.from(
		{ length: 6 },
		(_, i) => `<p>${i ? '' : `Chapter ${n} opens here. `}A ring of servers shares its keys so that adding or removing one server moves only a few of them, and paragraph ${i + 1} of this chapter says how.</p>`,
	).join('')}<h2>In practice</h2>${'<p>Each server owns the keys between it and the server before it on the ring, so a lookup walks to the next server clockwise.</p>'.repeat(3)}</article></body></html>`
const book: Record<string, () => { headers: Record<string, string>; body: string }> = {
	'/robots.txt': () => ({ headers: { 'content-type': 'text/plain' }, body: 'User-agent: *\nDisallow: /books/private/\n' }),
	'/books/rings/': () => ({ headers: html, body: contents('rings') }),
	'/books/private/': () => ({ headers: html, body: contents('private') }),
	...Object.fromEntries(CHAPTERS.flatMap((_, i) => (i + 1 === 7 ? [] : [[`/books/rings/${i + 1}.html`, () => ({ headers: html, body: chapter(i + 1) })]]))),
}

const pages: Record<string, () => { status?: number; headers: Record<string, string>; body?: Buffer | string; delayMs?: number }> = {
	...book,
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
