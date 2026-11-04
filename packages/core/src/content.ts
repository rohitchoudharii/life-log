import { z } from 'zod'

// Content is stored as our own blocks, never as foreign HTML, so the app renders it natively.
export const Block = z.discriminatedUnion('type', [
	z.object({ type: z.literal('heading'), level: z.number().int().min(1).max(6), text: z.string() }),
	z.object({ type: z.literal('paragraph'), text: z.string() }),
	z.object({ type: z.literal('list'), ordered: z.boolean(), items: z.array(z.string()) }),
	z.object({ type: z.literal('code'), language: z.string().optional(), text: z.string() }),
	z.object({ type: z.literal('quote'), text: z.string() }),
])
export type Block = z.infer<typeof Block>

/** `level` is 1 for top-level sections, 2 and 3 for nested ones; sections are stored in reading order. */
export type SectionDraft = { title: string; level: number; blocks: Block[]; wordCount: number }

/** At most three levels: sections, subsections, and their subsections. */
export const MAX_SECTION_LEVEL = 3

// Each content source turns its input into the same ordered sections.
// Phase 1 has `paste`; `web_capture`, `epub`, and `pdf_*` plug in here later.
export type ContentSourceType = 'paste' | 'web_capture' | 'epub' | 'pdf_upload' | 'pdf_url'

const TARGET_SECTION_WORDS = 450

const countWords = (text: string) => text.split(/\s+/).filter(Boolean).length

export function blockText(block: Block): string {
	switch (block.type) {
		case 'list':
			return block.items.join('\n')
		default:
			return block.text
	}
}

/** Parses pasted plain text or Markdown into blocks. */
export function parseMarkdown(input: string): Block[] {
	const lines = input.replace(/\r\n?/g, '\n').split('\n')
	const blocks: Block[] = []
	let paragraph: string[] = []
	let list: { ordered: boolean; items: string[] } | null = null

	const flush = () => {
		if (paragraph.length) blocks.push({ type: 'paragraph', text: paragraph.join(' ').trim() })
		paragraph = []
		if (list) blocks.push({ type: 'list', ...list })
		list = null
	}

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? ''
		const fence = line.match(/^```\s*([\w+-]*)/)
		if (fence) {
			flush()
			const body: string[] = []
			while (++i < lines.length && !(lines[i] ?? '').startsWith('```')) body.push(lines[i] ?? '')
			blocks.push({ type: 'code', language: fence[1] || undefined, text: body.join('\n') })
			continue
		}
		const heading = line.match(/^(#{1,6})\s+(.+)/)
		if (heading) {
			flush()
			blocks.push({ type: 'heading', level: heading[1]!.length, text: heading[2]!.trim() })
			continue
		}
		const item = line.match(/^\s*(?:([-*+])|(\d+)[.)])\s+(.+)/)
		if (item) {
			const ordered = Boolean(item[2])
			if (paragraph.length || (list && list.ordered !== ordered)) flush()
			list ??= { ordered, items: [] }
			list.items.push(item[3]!.trim())
			continue
		}
		if (line.startsWith('>')) {
			flush()
			blocks.push({ type: 'quote', text: line.replace(/^>\s?/, '').trim() })
			continue
		}
		if (!line.trim()) {
			flush()
			continue
		}
		if (list) flush()
		paragraph.push(line.trim())
	}
	flush()
	return blocks.filter((b) => blockText(b).trim().length > 0)
}

/**
 * Splits blocks into sections: a new section starts at every heading, and long runs
 * without headings are cut near TARGET_SECTION_WORDS at a block boundary.
 * Heading levels become section levels, shifted so the document's top heading is level 1
 * and never skipping a level, so the sections always form a tree. A heading with no text
 * of its own (a chapter right before its first subsection) is kept as a parent.
 */
export function splitSections(blocks: Block[], fallbackTitle: string): SectionDraft[] {
	const headingLevels = blocks.flatMap((b) => (b.type === 'heading' ? [b.level] : []))
	const top = Math.min(...headingLevels, MAX_SECTION_LEVEL)
	const sections: SectionDraft[] = []
	type Draft = SectionDraft & { heading: boolean }
	let current = null as Draft | null
	let part = 1

	const close = () => {
		if (current && (current.heading || current.blocks.length)) {
			const { heading: _, ...section } = current
			sections.push(section)
		}
	}
	const start = (title: string, level: number, heading: boolean) => {
		close()
		current = { title, level, blocks: [], wordCount: 0, heading }
	}

	for (const block of blocks) {
		if (block.type === 'heading') {
			const parentLimit = (current?.level ?? 0) + 1
			start(block.text, Math.max(1, Math.min(block.level - top + 1, parentLimit, MAX_SECTION_LEVEL)), true)
			part = 1
			continue
		}
		if (!current) start(fallbackTitle, 1, false)
		const section = current!
		const words = countWords(blockText(block))
		if (section.wordCount > 0 && section.wordCount + words > TARGET_SECTION_WORDS * 1.3) {
			part += 1
			start(`${section.title.replace(/ \(part \d+\)$/, '')} (part ${part})`, section.level, false)
		}
		current!.blocks.push(block)
		current!.wordCount += words
	}
	close()
	return sections
}

/**
 * Sections are stored in reading order with a level, so a section's subsections are the
 * run right after it with a deeper level. Returns the index just past that run.
 */
export function subtreeEnd(levels: readonly number[], index: number): number {
	let end = index + 1
	while (end < levels.length && levels[end]! > levels[index]!) end++
	return end
}

export function sectionText(section: { title: string; blocks: Block[] }): string {
	return [section.title, ...section.blocks.map(blockText)].join('\n\n')
}
