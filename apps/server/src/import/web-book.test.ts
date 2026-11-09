import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseRobots } from './robots'
import { findBook } from './web-book'

const saved = (name: string) => readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8')
/** The Rust Book's pages load their contents from toc.html; no other page is fetched. */
const fetchToc = async (url: string) => {
	if (url !== 'https://doc.rust-lang.org/book/toc.html') throw new Error(`unexpected fetch of ${url}`)
	return saved('rust-book-toc.html')
}
const find = (name: string, url: string) => findBook(saved(name), url, fetchToc)

describe('findBook on contents pages', () => {
	it('Crafting Interpreters: parts with their chapters nested, without the front matter or the design notes', async () => {
		const book = await find('ci-contents.html', 'https://craftinginterpreters.com/contents.html')
		expect(book).toMatchObject({ title: 'Crafting Interpreters', isContents: true })
		expect(book!.pages.slice(0, 3)).toEqual([
			{ url: 'https://craftinginterpreters.com/welcome.html', title: 'Welcome', level: 1, kind: 'body' },
			{ url: 'https://craftinginterpreters.com/introduction.html', title: 'Introduction', level: 2, kind: 'body' },
			{ url: 'https://craftinginterpreters.com/a-map-of-the-territory.html', title: 'A Map of the Territory', level: 2, kind: 'body' },
		])
		const titles = book!.pages.map((p) => p.title)
		expect(titles).not.toContain('Dedication')
		expect(titles).not.toContain('Acknowledgements')
		expect(titles.filter((t) => t.startsWith('Design Note'))).toEqual([])
		expect(titles).toContain('Scanning')
		expect(titles.at(-1)).toBe('Appendix II: Generated Syntax Tree Classes')
	})

	it("Eloquent JavaScript: a page without <body>, the introduction and the book's 21 chapters", async () => {
		const book = await find('ejs-index.html', 'https://eloquentjavascript.net/')
		expect(book).toMatchObject({ title: 'Eloquent JavaScript', isContents: true })
		expect(book!.pages).toHaveLength(22)
		expect(book!.pages[2]).toEqual({ url: 'https://eloquentjavascript.net/02_program_structure.html', title: 'Program Structure', level: 1, kind: 'body' })
	})

	it("the Python tutorial (Sphinx): its 16 chapters, not each chapter's sections", async () => {
		const book = await find('python-tutorial-index.html', 'https://docs.python.org/3/tutorial/index.html')
		expect(book).toMatchObject({ title: 'The Python Tutorial', isContents: true })
		expect(book!.pages.map((p) => p.title)).toHaveLength(16)
		expect(book!.pages[0]).toEqual({ url: 'https://docs.python.org/3/tutorial/appetite.html', title: '1. Whetting Your Appetite', level: 1, kind: 'body' })
		expect(book!.pages.every((p) => p.level === 1 && !p.url.includes('#'))).toBe(true)
	})

	it("The Rust Book (mdBook): the contents from toc.html, nested, without the title page", async () => {
		const book = await find('rust-book-index.html', 'https://doc.rust-lang.org/book/')
		expect(book).toMatchObject({ title: 'The Rust Programming Language', isContents: true })
		expect(book!.pages.slice(0, 4).map((p) => [p.level, p.title])).toEqual([
			[1, 'Foreword'],
			[1, 'Introduction'],
			[1, '1. Getting Started'],
			[2, '1.1. Installation'],
		])
	})

	it("Software Engineering at Google (O'Reilly HTMLBook): one page per chapter", async () => {
		const book = await find('swe-book-toc.html', 'https://abseil.io/resources/swe-book/html/toc.html')
		expect(book).toMatchObject({ title: 'Software Engineering at Google', isContents: true })
		const urls = book!.pages.map((p) => p.url)
		expect(new Set(urls).size).toBe(urls.length)
		expect(urls.slice(0, 2)).toEqual(['https://abseil.io/resources/swe-book/html/foreword.html', 'https://abseil.io/resources/swe-book/html/pr01.html'])
		expect(book!.pages.map((p) => p.title)).toContain('What Is Software Engineering?')
	})
})

describe('findBook on other pages', () => {
	it("knows a chapter of an mdBook book is part of it, not its contents", async () => {
		const book = await find('rust-ch04-01.html', 'https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html')
		expect(book?.isContents).toBe(false)
	})

	it('finds no book in a chapter with no contents list, a blog post, MDN or Wikipedia', async () => {
		for (const [name, url] of [
			['ci-scanning.html', 'https://craftinginterpreters.com/scanning.html'],
			['ejs-02.html', 'https://eloquentjavascript.net/02_program_structure.html'],
			['gds-blog-post.html', 'https://gds.blog.gov.uk/2026/10/19/opening-gov-uk-wallet-sandbox-to-digital-verification-services/'],
			['mdn-execution-model.html', 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Execution_model'],
			['wikipedia-spaced-repetition.html', 'https://en.wikipedia.org/wiki/Spaced_repetition'],
		])
			expect(await find(name!, url!), name).toBeNull()
	})
})

describe('parseRobots', () => {
	it('uses the group for our user agent over the * group', () => {
		const robots = parseRobots('User-agent: *\nDisallow: /\n\nUser-agent: LifeLogClubReader\nDisallow: /private/\n')
		expect(robots.allows('https://example.com/book/one.html')).toBe(true)
		expect(robots.allows('https://example.com/private/one.html')).toBe(false)
	})

	it('lets the longest matching rule win, with Allow winning a tie, and reads * and $', () => {
		const robots = parseRobots('User-agent: *\nDisallow: /book/\nAllow: /book/public/\nDisallow: /*.pdf$\nCrawl-delay: 3\n')
		expect(robots.allows('https://example.com/book/one.html')).toBe(false)
		expect(robots.allows('https://example.com/book/public/one.html')).toBe(true)
		expect(robots.allows('https://example.com/papers/a.pdf')).toBe(false)
		expect(robots.allows('https://example.com/papers/a.pdf.html')).toBe(true)
		expect(robots.crawlDelayMs).toBe(3000)
		expect(parseRobots('User-agent: *\nDisallow: /a\nAllow: /a\n').allows('https://example.com/a')).toBe(true)
	})

	it('allows everything when no group applies or the file is empty', () => {
		expect(parseRobots('User-agent: OtherBot\nDisallow: /\n').allows('https://example.com/x')).toBe(true)
		expect(parseRobots('').allows('https://example.com/x')).toBe(true)
	})
})
