import { describe, expect, it } from 'vitest'
import { type Block, blockText, countWords, insertHeadings, splitSections } from './content'

const p = (words: number, word = 'word'): Block => ({ type: 'paragraph', text: Array(words).fill(word).join(' ') })
const h = (level: number, text: string): Block => ({ type: 'heading', level, text })

describe('splitSections', () => {
	it('starts a section at each heading, with text before the first heading under the fallback title', () => {
		const sections = splitSections([p(5), h(1, 'Attention'), p(3), { type: 'code', text: 'x = 1' }, h(2, 'Heads'), p(2)], 'My note')
		expect(sections.map((s) => [s.title, s.level, s.wordCount])).toEqual([
			['My note', 1, 5],
			['Attention', 1, 5],
			['Heads', 2, 2],
		])
		expect(sections[1]!.blocks).toEqual([p(3), { type: 'code', text: 'x = 1' }])
	})

	it('nests headings up to three levels without skipping a level, keeping empty parents', () => {
		// Starts at h2, jumps from h3 to h5, and Part A has no text of its own.
		const sections = splitSections([h(2, 'Part A'), h(3, 'Ch 1'), p(2), h(5, 'Deep'), p(2), h(2, 'Part B'), p(2), h(3, 'Ch 2'), p(2)], 'Doc')
		expect(sections.map((s) => [s.title, s.level])).toEqual([
			['Part A', 1],
			['Ch 1', 2],
			['Deep', 3],
			['Part B', 1],
			['Ch 2', 2],
		])
		expect(splitSections([h(1, 'A'), p(1), h(2, 'B'), p(1), h(3, 'C'), p(1), h(4, 'D'), p(1)], 'Doc').map((s) => s.level)).toEqual([1, 2, 3, 3])
	})

	it('keeps a section of exactly 2,500 words whole', () => {
		expect(splitSections(Array(25).fill(p(100)), 'Essay').map((s) => s.wordCount)).toEqual([2500])
	})

	it('cuts a long section into the fewest near-equal parts, nested under the first', () => {
		// 2,600 words: two halves, not 2,500 and a 100-word stub.
		const sections = splitSections([h(2, 'Why'), ...Array(26).fill(p(100))], 'Essay')
		expect(sections.map((s) => [s.title, s.level, s.wordCount])).toEqual([
			['Why', 1, 1300],
			['Why (part 2)', 2, 1300],
		])
		expect(splitSections(Array(60).fill(p(100)), 'Essay').map((s) => s.wordCount)).toEqual([2000, 2000, 2000])
	})

	it("marks sections whose titles the AI wrote, including the parts they are cut into", () => {
		const blocks: Block[] = [p(10), { type: 'heading', level: 2, text: 'Why', source: 'ai' }, ...Array(30).fill(p(100)), h(2, 'Author')]
		expect(splitSections(blocks, 'Essay').map((s) => [s.title, s.aiTitle])).toEqual([
			['Essay', false],
			['Why', true],
			['Why (part 2)', true],
			['Author', false],
		])
	})

	it('never cuts inside a block', () => {
		const sections = splitSections([p(3000), p(10)], 'Essay')
		expect(sections.map((s) => s.wordCount)).toEqual([3000, 10])
	})
})

describe('insertHeadings', () => {
	it('adds AI headings before the blocks it names and keeps every block of the article', () => {
		const blocks: Block[] = [p(3, 'a'), p(3, 'b'), { type: 'code', text: 'x = 1' }, p(3, 'c')]
		const out = insertHeadings(blocks, [
			{ before: 0, title: 'Start', level: 2 },
			{ before: 2, title: 'Code', level: 3 },
		])
		expect(out.map((b) => (b.type === 'heading' ? `${b.level}:${b.text}:${b.source}` : blockText(b)))).toEqual([
			'2:Start:ai',
			'a a a',
			'b b b',
			'3:Code:ai',
			'x = 1',
			'c c c',
		])
		expect(out.filter((b) => b.type !== 'heading')).toEqual(blocks)
	})
})

describe('countWords', () => {
	it('counts words in text written without spaces', () => {
		expect(countWords('Hello, world. It works!')).toBe(4)
		expect(countWords('私は本を読みます')).toBeGreaterThan(3)
	})
})
