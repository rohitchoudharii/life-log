import { parseHTML } from 'linkedom'
import { describe, expect, it } from 'vitest'
import { Block } from '@life-log-club/domain'
import { htmlToBlocks, type DomNode } from './html'

const BASE = 'https://example.com/post/1'
const convert = (html: string) => {
	const { document } = parseHTML(`<!doctype html><html><body><article>${html}</article></body></html>`)
	return htmlToBlocks(document.querySelector('article') as unknown as DomNode, BASE)
}

describe('htmlToBlocks', () => {
	it('keeps the structure of an article as plain-text blocks', () => {
		const blocks = convert(`
			<h2>Tasks <em>and</em> microtasks</h2>
			<p>Promise callbacks are <a href="/mt">microtasks</a>.<br>They run first.</p>
			<div>Loose text <strong>in a div</strong><p>and a paragraph inside it</p></div>
			<ul><li>one</li><li>two <ul><li>nested</li></ul></li></ul>
			<ol><li>first</li></ol>
			<pre><code class="language-js">setTimeout(f, 0)
Promise.resolve().then(g)</code></pre>
			<blockquote><p>Quoted</p></blockquote>
			<table><tr><th>Queue</th><th>Runs</th></tr><tr><td>micro</td><td>first</td></tr></table>`)
		expect(blocks).toEqual([
			{ type: 'heading', level: 2, text: 'Tasks and microtasks' },
			{ type: 'paragraph', text: 'Promise callbacks are microtasks. They run first.', links: [{ start: 22, end: 32, href: 'https://example.com/mt' }] },
			{ type: 'paragraph', text: 'Loose text in a div' },
			{ type: 'paragraph', text: 'and a paragraph inside it' },
			{ type: 'list', ordered: false, items: ['one', 'two nested'] },
			{ type: 'list', ordered: true, items: ['first'] },
			{ type: 'code', language: 'js', text: 'setTimeout(f, 0)\nPromise.resolve().then(g)' },
			{ type: 'quote', text: 'Quoted' },
			{ type: 'paragraph', text: 'Queue | Runs' },
			{ type: 'paragraph', text: 'micro | first' },
		])
	})

	it('keeps where links point, as ranges of the squashed text', () => {
		const blocks = convert(`
			<p>See   <a href="https://other.org/a#part">the   <b>full</b> guide</a> and <a href="#top">this page</a>, or <a href="mailto:x@y.z">mail</a>.</p>
			<ul><li>plain</li><li>Read <a href="/b">B</a></li></ul>
			<blockquote>As <a href="/c">C</a> says</blockquote>`)
		expect(blocks).toEqual([
			{ type: 'paragraph', text: 'See the full guide and this page, or mail.', links: [{ start: 4, end: 18, href: 'https://other.org/a' }] },
			{ type: 'list', ordered: false, items: ['plain', 'Read B'], links: [{ start: 5, end: 6, href: 'https://example.com/b', item: 1 }] },
			{ type: 'quote', text: 'As C says', links: [{ start: 3, end: 4, href: 'https://example.com/c' }] },
		])
	})

	it('finds real image addresses: relative, lazy-loaded, srcset, and linked images', () => {
		const blocks = convert(`
			<figure><img src="/img/a.png" alt="A diagram" width="640" height="320"><figcaption>Figure 1</figcaption></figure>
			<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-src="https://cdn.example.com/b.jpg" alt="lazy">
			<img srcset="https://cdn.example.com/c-400.jpg 400w, https://cdn.example.com/c-1200.jpg 1200w" alt="set">
			<a href="/big"><img src="d.webp" alt="linked"></a>`)
		expect(blocks.filter((b) => b.type === 'image').map((b) => b.type === 'image' && [b.src, b.alt, b.mediaId])).toEqual([
			['https://example.com/img/a.png', 'A diagram', null],
			['https://cdn.example.com/b.jpg', 'lazy', null],
			['https://cdn.example.com/c-1200.jpg', 'set', null],
			['https://example.com/post/d.webp', 'linked', null],
		])
		expect(blocks[1]).toEqual({ type: 'paragraph', text: 'Figure 1' })
		expect(blocks[0]).toMatchObject({ width: 640, height: 320 })
	})

	it('keeps images inside list items and quotes, in reading order', () => {
		const blocks = convert(`
			<ol><li>Remove a server</li><li><p>Add a server</p><a href="/a.png"><img src="/a.png" alt="Ring"></a></li><li>Rebalance</li></ol>
			<blockquote>A note <img src="/b.png" alt="Note"></blockquote>`)
		expect(blocks.map((b) => (b.type === 'image' ? `image ${b.src}` : b.type === 'list' ? `list ${b.items.join(',')}` : b.type))).toEqual([
			'list Remove a server,Add a server',
			'image https://example.com/a.png',
			'list Rebalance',
			'quote',
			'image https://example.com/b.png',
		])
	})

	it('keeps a formula drawn as an image as its LaTeX, inside the sentence', () => {
		expect(
			convert(
				'<p>Retention is <span class="mwe-math-element"><img class="mwe-math-fallback-image-inline" src="https://wikimedia.org/api/rest_v1/media/math/render/svg/10c8" alt="{\\displaystyle R=e^{-{\\frac {t}{S}}},}"></span> where <img src="https://wikimedia.org/api/rest_v1/media/math/render/svg/4b0b" alt="{\\displaystyle R}"> is retrievability.</p>',
			),
		).toEqual([{ type: 'paragraph', text: 'Retention is R=e^{-{\\frac {t}{S}}}, where R is retrievability.' }])
	})
})

// Payloads from the OWASP XSS filter evasion cheat sheet and known mutation-XSS tricks. Whatever
// the page contains, only text and image addresses we fetch ourselves may come out.
const PAYLOADS = [
	'<script>alert(1)</script><p>after</p>',
	'<img src=x onerror=alert(1)>',
	'<IMG SRC=JaVaScRiPt:alert(1)>',
	'<img src="  java\tscript:alert(1)">',
	'<img src="javascript:alert(1)" alt="x">',
	'<img srcset="javascript:alert(1) 2x">',
	'<img src="data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+">',
	'<img src="data:text/html,<script>alert(1)</script>">',
	'<img src="vbscript:msgbox(1)">',
	'<img src="file:///etc/passwd">',
	'<a href="javascript:alert(1)">click me</a>',
	'<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">link</a>',
	'<svg onload=alert(1)><script>alert(1)</script></svg>',
	'<svg><image href="javascript:alert(1)"/></svg>',
	'<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
	'<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>',
	'<iframe srcdoc="<script>alert(1)</script>"></iframe>',
	'<iframe src="javascript:alert(1)"></iframe>',
	'<object data="javascript:alert(1)"></object><embed src="javascript:alert(1)">',
	'<p style="background:url(javascript:alert(1))" onclick="alert(1)">styled</p>',
	'<details open ontoggle=alert(1)>toggle</details>',
	'<form action="javascript:alert(1)"><button>go</button><input value="x"></form>',
	'<base href="javascript:alert(1)//"><img src="relative.png">',
	'<style>@import "javascript:alert(1)";</style><link rel=stylesheet href="javascript:alert(1)">',
	'<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
	'<template><script>alert(1)</script></template>',
	'<video><source onerror="alert(1)"></video><audio src=x onerror=alert(1)>',
	'<p>text</p><!--<script>alert(1)</script>-->',
]

describe('htmlToBlocks against XSS payloads', () => {
	it.each(PAYLOADS)('%s', (html) => {
		const blocks = convert(html)
		for (const b of blocks) {
			expect(Block.safeParse(b).success).toBe(true)
			if (b.type === 'image') {
				expect(b.mediaId).toBeNull()
				expect(b.src).toMatch(/^(https?:\/\/|data:image\/(png|jpeg|gif|webp);base64,)/)
			}
		}
		const json = JSON.stringify(blocks)
		expect(json).not.toMatch(/javascript:|vbscript:|onerror|onload|onclick|ontoggle|<script|data:text|file:/i)
		// Script bodies never become text either.
		expect(json).not.toContain('alert(1)')
	})

	it('keeps an escaped tag as harmless text, since it is only ever shown as text', () => {
		expect(convert('<p>Write &lt;script&gt; to add a script.</p>')).toEqual([{ type: 'paragraph', text: 'Write <script> to add a script.' }])
		// Aimed at filters that strip <script>: the parser sees an unknown element, and only text is left.
		expect(convert('<div><scr<script>ipt>alert(1)</script></div>')).toEqual([{ type: 'paragraph', text: 'ipt>alert(1)' }])
	})
})
