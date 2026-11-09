import { describe, expect, it } from 'vitest'
import { headingsRequest, parseHeadings } from './headings'

const reply = (headings: unknown) => JSON.stringify({ headings })

describe('headingsRequest', () => {
	it('numbers the blocks from 1 inside a section tag, with the task line first', () => {
		const req = headingsRequest('m', ['First.', 'Second.'])
		expect(req.system.split('\n')[0]).toBe('Task: headings')
		expect(req.user).toBe('<section>\n[1] First.\n\n[2] Second.\n</section>')
	})
})

describe('parseHeadings', () => {
	it('reads headings, counting blocks from 0, even inside a code fence', () => {
		const text = '```json\n' + reply([{ before: 1, title: ' Why  rows die ', level: 2 }, { before: 5, title: 'Vacuum', level: 3 }]) + '\n```'
		expect(parseHeadings(text, 5)).toEqual([
			{ before: 0, title: 'Why rows die', level: 2 },
			{ before: 4, title: 'Vacuum', level: 3 },
		])
	})

	it('refuses the whole reply when any heading is wrong', () => {
		const ok = { before: 2, title: 'Fine', level: 2 }
		for (const bad of [
			{ before: 0, title: 'Before the first block', level: 2 },
			{ before: 6, title: 'Past the last block', level: 2 },
			{ before: 2.5, title: 'Not a block', level: 2 },
			{ before: 4, title: '   ', level: 2 },
			{ before: 4, title: 'x'.repeat(121), level: 2 },
			{ before: 4, title: 'Level one', level: 1 },
			{ before: 4, title: 'Level four', level: 4 },
		])
			expect(parseHeadings(reply([ok, bad]), 5), JSON.stringify(bad)).toBeNull()
		// Out of order, or two at the same block.
		expect(parseHeadings(reply([{ ...ok, before: 4 }, ok]), 5)).toBeNull()
		expect(parseHeadings(reply([ok, ok]), 5)).toBeNull()
	})

	it('refuses replies that are not the expected JSON', () => {
		for (const text of ['', 'Sure! Here are some headings.', '{"headings": []}', '{"headings": "none"}', '[{"before":1}]', '{broken'])
			expect(parseHeadings(text, 5), text).toBeNull()
	})
})
