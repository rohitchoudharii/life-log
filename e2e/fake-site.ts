// A small web site that link imports fetch in e2e tests, serving saved real pages from the
// server's import fixtures. The e2e API allows its origin even though it is on this machine.
// Run with Node 26, which strips the types.
import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage } from 'node:http'

const fixture = (name: string) => readFileSync(new URL(`../apps/server/src/import/fixtures/${name}`, import.meta.url))
const html = { 'content-type': 'text/html; charset=utf-8' }
const PORT = Number(process.env.PORT ?? 8797)
/** Images from "another site": the members' page is opened at 127.0.0.1, so this origin is a different one. */
const FAKE_SITE_LOCAL = `http://localhost:${PORT}`

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

/**
 * A chapter on a site behind a login, as the extension sees it. Tests open it at 127.0.0.1, so
 * images at localhost come from another origin. `/members/login` sets the site's own cookie. With it the
 * chapter is whole, with an image that needs the cookie, a lazy-loaded one, one from a CDN that
 * allows CORS, and one from a CDN that doesn't (the server fetches that one). Without it the
 * page is a preview: two paragraphs and a box asking to subscribe.
 */
const MEMBERS_TITLE = 'Chapter 1: Why the ring holds'
const signedIn = (req: IncomingMessage) => /(^|;\s*)member=1/.test(req.headers.cookie ?? '')
const memberChapter = (req: IncomingMessage) => {
	const para = (n: number) =>
		`<p>Paragraph ${n}. A ring of servers keeps its keys in place when one server leaves, because each key moves only to the next server along the ring, and the rest stay where they were.</p>`
	const head = `<!doctype html><html><head><title>${MEMBERS_TITLE} · The Members' Book</title><script type="application/ld+json">{"@type":"Article","wordCount":1800,"isAccessibleForFree":false}</script></head><body><article><h1>${MEMBERS_TITLE}</h1>`
	if (!signedIn(req))
		return `${head}${para(1)}${para(2)}<div class="paywall"><p>Subscribe to read the rest of this chapter.</p><a href="/members/login">Already a subscriber? Sign in</a></div></article></body></html>`
	const part = (title: string, from: number) => `<h2>${title}</h2>${Array.from({ length: 22 }, (_, i) => para(from + i)).join('')}`
	return `${head}${part('Keys on a ring', 1)}<figure><img src="/members/figure.png" alt="A ring of four servers" width="240" height="140"><figcaption>Four servers on a ring.</figcaption></figure>${part(
		'When a server leaves',
		23,
	)}<p><img data-src="/members/lazy.png" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="A lazy-loaded figure"></p><p><img src="${FAKE_SITE_LOCAL}/cdn/figure.png" alt="A figure from a CDN that allows CORS"></p><p><img src="${FAKE_SITE_LOCAL}/nocors/figure.png" alt="A figure from a CDN without CORS"></p>${part('What keeps it steady', 45)}</article></body></html>`
}
const png = fixture('figure.png')

const pages: Record<string, (req: IncomingMessage) => { status?: number; headers: Record<string, string>; body?: Buffer | string; delayMs?: number }> = {
	...book,
	'/members/login': () => ({ status: 302, headers: { 'set-cookie': 'member=1; Path=/; SameSite=Lax', location: '/members/chapter-1' } }),
	'/members/chapter-1': (req) => ({ headers: html, body: memberChapter(req) }),
	'/members/figure.png': (req) => (signedIn(req) ? { headers: { 'content-type': 'image/png' }, body: png } : { status: 403, headers: html, body: 'Members only' }),
	'/members/lazy.png': (req) => (signedIn(req) ? { headers: { 'content-type': 'image/png' }, body: png } : { status: 403, headers: html, body: 'Members only' }),
	'/cdn/figure.png': () => ({ headers: { 'content-type': 'image/png', 'access-control-allow-origin': '*' }, body: png }),
	'/nocors/figure.png': () => ({ headers: { 'content-type': 'image/png' }, body: png }),
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
	const page = pages[new URL(req.url ?? '/', 'http://x').pathname]?.(req)
	if (!page) return res.writeHead(404, html).end('<p>Not found</p>')
	setTimeout(() => res.writeHead(page.status ?? 200, page.headers).end(page.body), page.delayMs ?? 0)
})

server.listen(PORT)
