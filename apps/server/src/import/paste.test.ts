import { describe, expect, it } from 'vitest'
import { ExtractError } from './extract'
import { pastedBlocks, readPaste } from './paste'

describe('pastedBlocks', () => {
	it('makes plain text into paragraphs at its blank lines, joining the lines inside one', () => {
		expect(pastedBlocks('First line\nsame paragraph.\n\n\nSecond paragraph.\r\n')).toEqual([
			{ type: 'paragraph', text: 'First line same paragraph.' },
			{ type: 'paragraph', text: 'Second paragraph.' },
		])
	})

	it('reads Markdown blocks, and keeps code, snake_case and stars in code as they are', () => {
		const markdown = [
			'Deep work',
			'=========',
			'Some **bold** and *soft* words, a snake_case_name and `a * b`.',
			'## Rules ##',
			'- one',
			'  goes on',
			'* two',
			'1. first',
			'2) second',
			'> A quote',
			'> on two lines',
			'---',
			'```js',
			'# not a heading',
			'const x = *y*',
			'```',
			'| Name | Words |',
			'| --- | ---: |',
			'| Peak | 300 |',
			'![A chart of practice](chart.png)',
		].join('\n')
		expect(pastedBlocks(markdown)).toEqual([
			{ type: 'heading', level: 1, text: 'Deep work' },
			{ type: 'paragraph', text: 'Some bold and soft words, a snake_case_name and a * b.' },
			{ type: 'heading', level: 2, text: 'Rules' },
			{ type: 'list', ordered: false, items: ['one goes on', 'two'] },
			{ type: 'list', ordered: true, items: ['first', 'second'] },
			{ type: 'quote', text: 'A quote on two lines' },
			{ type: 'code', language: 'js', text: '# not a heading\nconst x = *y*' },
			{ type: 'table', header: true, rows: [['Name', 'Words'], ['Peak', '300']] },
			{ type: 'image', mediaId: null, alt: 'A chart of practice' },
		])
	})

	it('keeps a link’s words in the text and points them at its address, without its #fragment', () => {
		const [paragraph, list] = pastedBlocks('Read [the **study**](https://example.com/a#part), [flow](https://en.wikipedia.org/wiki/Flow_(psychology)) and [this](javascript:alert(1)).\n\n- x\n- see [docs](http://example.com/d)')
		expect(paragraph).toEqual({
			type: 'paragraph',
			text: 'Read the study, flow and this.',
			links: [
				{ start: 5, end: 14, href: 'https://example.com/a' },
				{ start: 16, end: 20, href: 'https://en.wikipedia.org/wiki/Flow_(psychology)' },
			],
		})
		expect(list).toEqual({ type: 'list', ordered: false, items: ['x', 'see docs'], links: [{ start: 4, end: 8, href: 'http://example.com/d', item: 1 }] })
	})
})

describe('readPaste', () => {
	it('splits at the headings and takes the title from the first one', () => {
		const paste = readPaste('## How it starts\n\nPractice needs feedback.\n\n## Where it leads\n\nExperts build mental models.')
		expect(paste.title).toBe('How it starts')
		expect(paste.sections.map((s) => [s.title, s.wordCount])).toEqual([
			['How it starts', 3],
			['Where it leads', 4],
		])
		expect(paste.wordCount).toBe(7)
	})

	it('takes the first eight words as the title of text with no heading, unless a title is given', () => {
		const text = 'Deliberate practice is not the same as playing more games every day.'
		expect(readPaste(text).title).toBe('Deliberate practice is not the same as playing…')
		expect(readPaste('Short note here.').title).toBe('Short note here')
		expect(readPaste(text, '  Peak notes ').title).toBe('Peak notes')
		expect(readPaste(text).sections).toHaveLength(1)
	})

	it('marks a long text with no headings for AI headings, and refuses text with nothing to read', () => {
		const long = Array.from({ length: 100 }, () => 'Every expert once practised slowly with feedback from a teacher, then sped up.').join('\n\n')
		expect(readPaste(long).sections.every((s) => s.headingsPending)).toBe(true)
		expect(readPaste(`# Title\n\n${long}`).sections.every((s) => !s.headingsPending)).toBe(true)
		expect(() => readPaste('---\n\n```\n\n```')).toThrow(ExtractError)
	})
})
