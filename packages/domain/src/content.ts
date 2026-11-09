import { z } from 'zod'

/**
 * A link in a block's text: characters `start` to `end` of the text (of item `item`, in a list)
 * point at `href`, an http(s) address without its #fragment.
 */
export const Link = z.object({
	start: z.number().int().min(0),
	end: z.number().int().positive(),
	href: z.string(),
	item: z.number().int().min(0).optional(),
})
export type Link = z.infer<typeof Link>

// Content is stored as our own blocks, never as foreign HTML, so clients render it natively and
// nothing from a page can run when it is shown.
export const Block = z.discriminatedUnion('type', [
	/** `source: 'ai'` marks a heading the AI added to an article that had none (issue #1). */
	z.object({ type: z.literal('heading'), level: z.number().int().min(1).max(6), text: z.string(), source: z.literal('ai').optional() }),
	z.object({ type: z.literal('paragraph'), text: z.string(), links: z.array(Link).optional() }),
	z.object({ type: z.literal('list'), ordered: z.boolean(), items: z.array(z.string()), links: z.array(Link).optional() }),
	z.object({ type: z.literal('code'), language: z.string().optional(), text: z.string() }),
	z.object({ type: z.literal('quote'), text: z.string(), links: z.array(Link).optional() }),
	/**
	 * An image the server stores and serves itself. `mediaId` is null until it is saved; until then
	 * clients show the alt text. `src` is where it came from and is never rendered.
	 */
	z.object({
		type: z.literal('image'),
		mediaId: z.uuid().nullable(),
		alt: z.string(),
		width: z.number().int().positive().optional(),
		height: z.number().int().positive().optional(),
		src: z.string().optional(),
	}),
])
export type Block = z.infer<typeof Block>

/**
 * `level` is 1 for top-level sections, 2 and 3 for nested ones; sections are stored in reading
 * order. `aiTitle` is true when the title is a heading the AI wrote, not the author.
 */
export type SectionDraft = { title: string; level: number; blocks: Block[]; wordCount: number; aiTitle: boolean }

/** At most three levels: sections, subsections, and their subsections. */
export const MAX_SECTION_LEVEL = 3

/** A section with more words than this is cut at a block boundary (issue #1). */
export const MAX_SECTION_WORDS = 2500

const words = new Intl.Segmenter(undefined, { granularity: 'word' })

/** Counts words the way a reader would, including in languages written without spaces. */
export function countWords(text: string): number {
	let n = 0
	for (const s of words.segment(text)) if (s.isWordLike) n++
	return n
}

export function blockText(block: Block): string {
	switch (block.type) {
		case 'list':
			return block.items.join('\n')
		case 'image':
			return ''
		default:
			return block.text
	}
}

/**
 * Splits an article's blocks into sections, the unit of recall. Every heading starts a section,
 * and heading levels become section levels, shifted so the top heading is level 1 and never
 * skipping a level, so the sections form a tree. A heading with no text of its own (a chapter
 * right before its first subsection) is kept as a parent.
 *
 * A section past MAX_SECTION_WORDS is cut into the fewest near-equal parts at block boundaries,
 * never inside a block, so a 2,600-word section becomes two halves rather than a full part and a
 * stub. Later parts nest under the first.
 */
export function splitSections(blocks: Block[], fallbackTitle: string): SectionDraft[] {
	const headingLevels = blocks.flatMap((b) => (b.type === 'heading' ? [b.level] : []))
	const top = Math.min(...headingLevels, MAX_SECTION_LEVEL)
	const groups: (SectionDraft & { heading: boolean })[] = []
	for (const block of blocks) {
		if (block.type === 'heading') {
			const parentLimit = (groups.at(-1)?.level ?? 0) + 1
			const level = Math.max(1, Math.min(block.level - top + 1, parentLimit, MAX_SECTION_LEVEL))
			groups.push({ title: block.text, level, blocks: [], wordCount: 0, aiTitle: block.source === 'ai', heading: true })
			continue
		}
		if (!groups.length) groups.push({ title: fallbackTitle, level: 1, blocks: [], wordCount: 0, aiTitle: false, heading: false })
		const group = groups.at(-1)!
		group.blocks.push(block)
		group.wordCount += countWords(blockText(block))
	}
	return groups.filter((g) => g.heading || g.blocks.length).flatMap(({ heading: _, ...g }) => cut(g))
}

function cut(section: SectionDraft): SectionDraft[] {
	if (section.wordCount <= MAX_SECTION_WORDS) return [section]
	const parts = Math.ceil(section.wordCount / MAX_SECTION_WORDS)
	const target = section.wordCount / parts
	const out: SectionDraft[] = [{ ...section, blocks: [], wordCount: 0 }]
	let before = 0
	for (const block of section.blocks) {
		const n = countWords(blockText(block))
		const current = out.at(-1)!
		// A block goes to the next part when most of it lies past this part's share.
		if (current.wordCount > 0 && out.length < parts && before + n / 2 > out.length * target)
			out.push({
				title: `${section.title} (part ${out.length + 1})`,
				level: Math.min(section.level + 1, MAX_SECTION_LEVEL),
				blocks: [],
				wordCount: 0,
				aiTitle: section.aiTitle,
			})
		out.at(-1)!.blocks.push(block)
		out.at(-1)!.wordCount += n
		before += n
	}
	return out
}

/** Where the AI says a heading goes: before block `before` (counting from 0), at level 2 or 3. */
export type HeadingPlacement = { before: number; title: string; level: 2 | 3 }

/** True when an article has no headings of its own in its body. */
export const hasHeadings = (blocks: readonly Block[]) => blocks.some((b) => b.type === 'heading')

/**
 * Inserts the AI's headings as heading blocks marked `source: 'ai'`. Every other block is kept as
 * it is and in order, so the article's text can't change, whatever the AI wrote.
 */
export function insertHeadings(blocks: readonly Block[], headings: readonly HeadingPlacement[]): Block[] {
	const at = new Map(headings.map((h) => [h.before, h]))
	return blocks.flatMap((block, i) => {
		const h = at.get(i)
		return h ? [{ type: 'heading', level: h.level, text: h.title, source: 'ai' } as const, block] : [block]
	})
}
