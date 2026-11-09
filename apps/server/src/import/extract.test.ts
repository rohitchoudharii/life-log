import { readFileSync } from 'node:fs'
import { blockText, countWords, splitSections } from '@life-log-club/domain'
import { describe, expect, it } from 'vitest'
import { type Article, decodeHtml, extractArticle, SIGN_IN } from './extract'

const prose = (n: number) => Array.from({ length: n }, (_, i) => `<p>Sentence ${i} about how consistent hashing spreads keys across a ring of servers, so adding one moves few keys.</p>`).join('')

describe('extractArticle', () => {
	it('keeps figures, turns videos into a poster and a link, and drops icons', () => {
		const html = `<html><head><title>Chapter 1. Rings</title></head><body><article>
			<h1>Chapter 1. Rings</h1>
			<img src="/logo.png" width="16" height="16" alt="logo">
			${prose(6)}
			<figure><div class="figure media"><img src="/fig1.png" alt="A ring"><h6>Figure 1-1. A hash ring</h6></div></figure>
			${prose(4)}
			<video src="/talk.mp4" poster="/poster.jpg" title="Ring demo"></video>
			<iframe src="https://www.youtube.com/embed/abc123XYZ_-"></iframe>
			${prose(4)}
		</article></body></html>`
		const { blocks } = extractArticle(html, 'https://learning.example.com/book/ch01.html')
		const images = blocks.filter((b) => b.type === 'image').map((b) => (b as { src: string }).src)
		const text = blocks.filter((b) => b.type === 'paragraph').map((b) => (b as { text: string }).text)

		expect(images).toEqual([
			'https://learning.example.com/fig1.png',
			'https://learning.example.com/poster.jpg',
			'https://i.ytimg.com/vi/abc123XYZ_-/hqdefault.jpg',
		])
		expect(text).toContain('Figure 1-1. A hash ring')
		expect(blocks.some((b) => b.type === 'heading' && (b as { text: string }).text.startsWith('Figure'))).toBe(false)
		expect(text.some((t) => t.includes('https://learning.example.com/talk.mp4'))).toBe(true)
		expect(text.some((t) => t.includes('https://www.youtube.com/watch?v=abc123XYZ_-'))).toBe(true)
	})

	it('reads pages hidden until their scripts run, even when the scripts outweigh the text', () => {
		const html = `<html><body><div style="visibility:hidden;min-height:100vh"><article><h1>Hub</h1>${prose(8)}
			<ul><li><a href="/python/intro/">Introduction</a></li></ul></article></div>
			<script id="__NEXT_DATA__" type="application/json">${'{"x":1}'.repeat(5000)}</script></body></html>`
		const { blocks } = extractArticle(html, 'https://site.example/hub/')
		expect(blocks.find((b) => b.type === 'list')).toEqual({ type: 'list', ordered: false, items: ['Introduction'], links: [{ start: 0, end: 12, href: 'https://site.example/python/intro/', item: 0 }] })
	})
})

const load = (name: string) => readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8')
const sections = (article: Article) => splitSections(article.blocks, article.title)
const allText = (article: Article) => article.blocks.map(blockText).join('\n')

describe('extractArticle on saved pages', () => {
	it('Wikipedia: keeps the section tree, the canonical address and the text', () => {
		const article = extractArticle(load('wikipedia-spaced-repetition.html'), 'https://en.wikipedia.org/wiki/Spaced_repetition?utm_source=x')
		expect(article.title).toBe('Spaced repetition')
		expect(article.canonicalUrl).toBe('https://en.wikipedia.org/wiki/Spaced_repetition')
		const tree = sections(article).map((s) => [s.title, s.level])
		expect(tree).toEqual(expect.arrayContaining([['History', 1], ['Implementations', 1], ['Software', 2], ['Paper flash cards', 2]]))
		const text = allText(article)
		expect(text).toContain('Spaced repetition is an evidence-based learning technique that is usually performed with flashcards.')
		expect(text).toContain('The method of spaced repetition was first conceived of in the 1880s by German scientist Hermann Ebbinghaus.')
	})

	it('MDN: uses the page heading as the title, keeps code blocks and nested sections', () => {
		const article = extractArticle(load('mdn-execution-model.html'), 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Execution_model')
		expect(article.title).toBe('JavaScript execution model')
		expect(article.canonicalUrl).toBe('https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Execution_model')
		expect(article.blocks.filter((b) => b.type === 'code').length).toBeGreaterThan(3)
		const tree = sections(article).map((s) => [s.title, s.level])
		expect(tree).toEqual(expect.arrayContaining([['Job queue and event loop', 1], ['Never blocking', 2]]))
		expect(allText(article)).toContain('JavaScript execution requires the cooperation of two pieces of software: the JavaScript engine and the host environment.')
	})
})

describe('extractArticle on chapters of web books', () => {
	const read = (name: string, url: string) => {
		const article = extractArticle(load(name), url)
		return { article, text: allText(article), headings: article.blocks.flatMap((b) => (b.type === 'heading' ? [b.text] : [])) }
	}

	it('Eloquent JavaScript: reads a page written without <html>, <head> or <body>', () => {
		const { article, text } = read('ejs-02.html', 'https://eloquentjavascript.net/02_program_structure.html')
		expect(article.title).toBe('Program Structure')
		expect(text).toContain('In this chapter, we will start to do things that can actually be called programming.')
		expect(countWords(text)).toBeGreaterThan(4000)
	})

	it("The Rust Book (mdBook): the chapter's own title, without the help popup and menus", () => {
		const { article, text, headings } = read('rust-ch04-01.html', 'https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html')
		expect(article.title).toBe('What Is Ownership?')
		expect(headings[0]).toBe('The Stack and the Heap')
		expect(text).toMatch(/^Ownership is a set of rules that govern how a Rust program manages memory\./)
		expect(text).not.toMatch(/Keyboard shortcuts|Previous chapter|Next chapter/)
	})

	it('Crafting Interpreters: section numbers kept apart from their titles, no chapter number or next links', () => {
		const { article, text, headings } = read('ci-scanning.html', 'https://craftinginterpreters.com/scanning.html')
		expect(article.title).toBe('Scanning')
		expect(headings.slice(0, 2)).toEqual(['4.1 The Interpreter Framework', '4.1.1 Error handling'])
		expect(text).toMatch(/^Take big bites\./)
		expect(text).toContain('The first step in any compiler or interpreter is scanning.')
		expect(text).not.toMatch(/Next Chapter|Representing Code/)
	})
})

describe('extractArticle refusals and metadata', () => {
	it('refuses a sign-in form with little else on the page', () => {
		const html = `<html><body><h1>Sign in</h1><form><input name="email"><input type="password" name="pw"><button>Sign in</button></form><p>Welcome back. Sign in to keep reading.</p></body></html>`
		expect(() => extractArticle(html, 'https://news.example/story')).toThrow(SIGN_IN)
	})

	it('refuses a short preview the page marks as for subscribers', () => {
		const html = `<html><head><script type="application/ld+json">{"@type":"NewsArticle","isAccessibleForFree":false}</script></head>
			<body><article><h1>Big story</h1>${prose(5)}</article></body></html>`
		expect(() => extractArticle(html, 'https://news.example/big')).toThrow(SIGN_IN)
	})

	it('reads the author and date, ignores a canonical address on another site, and drops a heading that repeats the title', () => {
		const html = `<html><head><title>Rings</title><link rel="canonical" href="https://elsewhere.example/rings">
			<script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","author":{"@type":"Person","name":"Ada Lovelace"},"datePublished":"2026-03-04T10:00:00Z"}</script></head>
			<body><article><h1>Rings</h1>${prose(8)}</article></body></html>`
		const article = extractArticle(html, 'https://www.blog.example/rings')
		expect(article.author).toBe('Ada Lovelace')
		expect(article.publishedAt?.toISOString()).toBe('2026-03-04T10:00:00.000Z')
		expect(article.canonicalUrl).toBeNull()
		expect(article.blocks[0]?.type).toBe('paragraph')
	})

	it('decodes a page by its meta charset, and a byte-order mark wins over a wrong declaration', () => {
		const latin = Buffer.concat([Buffer.from('<meta charset="windows-1252"><p>caf'), Buffer.from([0xe9]), Buffer.from('</p>')])
		expect(decodeHtml(latin, 'text/html')).toContain('café')
		const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<p>café</p>')])
		expect(decodeHtml(bom, 'text/html; charset=windows-1252')).toContain('café')
	})
})
