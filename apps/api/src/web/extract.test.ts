import { describe, expect, it } from 'vitest'
import { extractArticle } from './extract'

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
