import {
	ARTICLE_HEADINGS_MIN_WORDS,
	type Block,
	type BookSection,
	blockText,
	hasHeadings,
	type Link,
	splitSections,
} from '@life-log-club/domain'
import { ExtractError } from './extract'

export const EMPTY_PASTE = 'There is no text to read in what you pasted.'
const TOO_MANY_SECTIONS = 'This text has too many headings to read as one reading. Paste a part of it.'
const MAX_SECTIONS = 2000

const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+-]*)/
const BULLET = /^ {0,3}[-*+]\s+(.*)$/
const NUMBERED = /^ {0,3}\d{1,9}[.)]\s+(.*)$/
const QUOTE = /^ {0,3}>\s?(.*)$/
const IMAGE = /^\s*!\[([^\]]*)\]\([^)]*\)\s*$/
const RULE = /^ {0,3}([-*_])(\s*\1){2,}\s*$/
const UNDERLINE = /^ {0,3}(=+|-+)\s*$/
const TABLE_ROW = /^\s*\|.*\|\s*$/
const TABLE_RULE = /^\s*\|?(\s*:?-+:?\s*\|)+\s*:?-*:?\s*\|?\s*$/
// The address may hold one level of parentheses, as in .../wiki/Flow_(psychology).
const LINK = /\[([^\]]+)\]\(\s*<?((?:[^()\s<>]|\([^()\s]*\))+)>?(?:\s+"[^"]*")?\s*\)/g

/** Removes emphasis and escapes from Markdown that has no links or code in it. */
const plain = (text: string) =>
	text
		.replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, '$2')
		.replace(/(^|[^\w*])\*(?=\S)(.+?)(?<=\S)\*(?!\w)/g, '$1$2')
		.replace(/(^|\W)_(?=\S)(.+?)(?<=\S)_(?!\w)/g, '$1$2')
		.replace(/~~(.+?)~~/g, '$1')
		.replace(/\\([\\`*_{}[\]()#+\-.!>|~])/g, '$1')

/** An http(s) address without its #fragment, as links in blocks are stored; null for anything else. */
function href(url: string) {
	const parsed = URL.parse(url)
	if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) return null
	parsed.hash = ''
	return parsed.href
}

/**
 * One line or paragraph of Markdown as plain text with its links. Code spans keep their text,
 * links keep their words and point at their address, and emphasis marks go.
 */
function inline(markdown: string, item?: number): { text: string; links: Link[] } {
	let text = ''
	const links: Link[] = []
	for (const [k, part] of markdown.split(/(`+[^`]+?`+)/).entries()) {
		if (k % 2) {
			text += part.replace(/^`+\s?|\s?`+$/g, '')
			continue
		}
		let at = 0
		for (const m of part.matchAll(LINK)) {
			text += plain(part.slice(at, m.index))
			const words = plain(m[1]!)
			const to = href(m[2]!)
			if (to && words) links.push({ start: text.length, end: text.length + words.length, href: to, ...(item !== undefined && { item }) })
			text += words
			at = m.index + m[0].length
		}
		text += plain(part.slice(at))
	}
	return { text: text.replace(/\s+/g, ' ').trim(), links }
}

const withLinks = <T extends Block>(block: T, links: Link[]): T => (links.length ? { ...block, links } : block)

const cells = (row: string) =>
	row
		.trim()
		.replace(/^\||\|$/g, '')
		.split(/(?<!\\)\|/)
		.map((c) => inline(c).text)

/**
 * Turns pasted text or Markdown into blocks. Plain text becomes paragraphs at its blank lines.
 * Markdown headings (`#` or underlined), lists, quotes, code fences and pipe tables become their
 * own blocks. An image keeps only its alt text, because pasted text brings no files.
 */
export function pastedBlocks(input: string): Block[] {
	const lines = input.replace(/\r\n?/g, '\n').split('\n')
	const blocks: Block[] = []
	let paragraph: string[] = []
	let quote: string[] = []
	let list: { ordered: boolean; items: string[] } | null = null

	const endParagraph = () => {
		const { text, links } = inline(paragraph.join(' '))
		if (text) blocks.push(withLinks({ type: 'paragraph', text }, links))
		paragraph = []
	}
	const endQuote = () => {
		const { text, links } = inline(quote.join(' '))
		if (text) blocks.push(withLinks({ type: 'quote', text }, links))
		quote = []
	}
	const endList = () => {
		if (list) {
			const parsed = list.items.map((item, k) => inline(item, k))
			blocks.push(withLinks({ type: 'list', ordered: list.ordered, items: parsed.map((p) => p.text) }, parsed.flatMap((p) => p.links)))
		}
		list = null
	}
	const end = () => {
		endParagraph()
		endQuote()
		endList()
	}

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!
		const fence = FENCE.exec(line)
		if (fence) {
			end()
			const code: string[] = []
			while (++i < lines.length && !lines[i]!.trimStart().startsWith(fence[1]!)) code.push(lines[i]!)
			if (code.some((c) => c.trim())) blocks.push({ type: 'code', text: code.join('\n'), ...(fence[2] && { language: fence[2] }) })
			continue
		}
		if (!line.trim()) {
			end()
			continue
		}
		// "Title" over "=====" or "-----" is a heading, when it is one line of text.
		const underline = UNDERLINE.exec(line)
		if (underline && paragraph.length === 1 && !quote.length && !list) {
			const { text } = inline(paragraph[0]!)
			paragraph = []
			if (text) blocks.push({ type: 'heading', level: underline[1]!.startsWith('=') ? 1 : 2, text })
			continue
		}
		const heading = HEADING.exec(line)
		if (heading) {
			end()
			const { text } = inline(heading[2]!)
			if (text) blocks.push({ type: 'heading', level: heading[1]!.length, text })
			continue
		}
		if (RULE.test(line)) {
			end()
			continue
		}
		const image = IMAGE.exec(line)
		if (image) {
			end()
			if (image[1]!.trim()) blocks.push({ type: 'image', mediaId: null, alt: image[1]!.trim() })
			continue
		}
		if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]!)) {
			end()
			const rows = [cells(line)]
			i++
			while (i + 1 < lines.length && TABLE_ROW.test(lines[i + 1]!)) rows.push(cells(lines[++i]!))
			blocks.push({ type: 'table', rows, header: true })
			continue
		}
		const item = BULLET.exec(line) ?? NUMBERED.exec(line)
		if (item) {
			const ordered = !BULLET.test(line)
			endParagraph()
			endQuote()
			if (list && list.ordered !== ordered) endList()
			list ??= { ordered, items: [] }
			list.items.push(item[1]!)
			continue
		}
		const quoted = QUOTE.exec(line)
		if (quoted) {
			endParagraph()
			endList()
			quote.push(quoted[1]!)
			continue
		}
		// An indented line under a list item goes on with that item.
		if (list && /^\s/.test(line)) {
			list.items[list.items.length - 1] += ` ${line.trim()}`
			continue
		}
		endQuote()
		endList()
		paragraph.push(line.trim())
	}
	end()
	return blocks
}

/** The first heading, or else the text's first words. */
function titleOf(blocks: Block[]) {
	const heading = blocks.find((b) => b.type === 'heading')
	if (heading) return heading.text.slice(0, 200)
	const words = blocks.map(blockText).join(' ').split(/\s+/).filter(Boolean)
	const first = words.slice(0, 8).join(' ').replace(/[.,;:!?]+$/, '')
	return words.length > 8 ? `${first}…` : first
}

/**
 * Reads pasted text into a reading's title and sections, split like an article: the author's
 * headings are the boundaries, and a long text with no headings gets AI headings when the member
 * first opens it. Throws an ExtractError when there is nothing to read or too many sections.
 */
export function readPaste(text: string, title?: string) {
	const blocks = pastedBlocks(text)
	const name = title?.trim() || titleOf(blocks)
	const drafts = splitSections(blocks, name)
	// Headings are not counted, as in every other reading.
	const wordCount = drafts.reduce((n, s) => n + s.wordCount, 0)
	if (!wordCount) throw new ExtractError(EMPTY_PASTE)
	if (drafts.length > MAX_SECTIONS) throw new ExtractError(TOO_MANY_SECTIONS)
	const headingsPending = !hasHeadings(blocks) && wordCount >= ARTICLE_HEADINGS_MIN_WORDS
	const sections: BookSection[] = drafts.map((s) => ({ ...s, chapter: 0, headingsPending, notes: [] }))
	return { title: name, wordCount, sections }
}
