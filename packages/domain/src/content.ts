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

/**
 * A note marker in a block's text: note `id` opens at character `at` (of item `item`, in a list).
 * The marker's own label ("3") is not in the text, so it never reaches recall or word counts.
 */
export const NoteRef = z.object({ at: z.number().int().min(0), id: z.string(), item: z.number().int().min(0).optional() })
export type NoteRef = z.infer<typeof NoteRef>

// Content is stored as our own blocks, never as foreign HTML, so clients render it natively and
// nothing from a page can run when it is shown.
export const Block = z.discriminatedUnion('type', [
	/** `source: 'ai'` marks a heading the AI added to an article that had none (issue #1). */
	z.object({ type: z.literal('heading'), level: z.number().int().min(1).max(6), text: z.string(), source: z.literal('ai').optional() }),
	z.object({ type: z.literal('paragraph'), text: z.string(), links: z.array(Link).optional(), notes: z.array(NoteRef).optional() }),
	z.object({ type: z.literal('list'), ordered: z.boolean(), items: z.array(z.string()), links: z.array(Link).optional(), notes: z.array(NoteRef).optional() }),
	z.object({ type: z.literal('code'), language: z.string().optional(), text: z.string() }),
	z.object({ type: z.literal('quote'), text: z.string(), links: z.array(Link).optional(), notes: z.array(NoteRef).optional() }),
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
	/** Where a page of the source (a PDF) starts, so the reader can point back to it. */
	z.object({ type: z.literal('page'), number: z.number().int().positive() }),
])
export type Block = z.infer<typeof Block>

/** A footnote or endnote, which opens from its markers. `label` is what the marker shows ("3", "*"). */
export const Note = z.object({ id: z.string(), label: z.string(), blocks: z.array(Block) })
export type Note = z.infer<typeof Note>

/** The ids of the notes a block's markers open, in order. */
export const noteIds = (block: Block) => ('notes' in block ? (block.notes ?? []).map((n) => n.id) : [])

/**
 * `body` sections are read and recalled. `reference` sections (a bibliography) are kept to read,
 * but get no questions and don't count towards progress (issue #2).
 */
export type SectionKind = 'body' | 'reference'

/**
 * `level` is 1 for top-level sections, 2 and 3 for nested ones; sections are stored in reading
 * order. `aiTitle` is true when the title is a heading the AI wrote, not the author.
 */
export type SectionDraft = { title: string; level: number; blocks: Block[]; wordCount: number; aiTitle: boolean; kind: SectionKind }

/** At most three levels: sections, subsections, and their subsections. */
export const MAX_SECTION_LEVEL = 3

/** A section with more words than this is cut at a block boundary (issue #1). */
export const MAX_SECTION_WORDS = 2500

/** An article this long with no headings gets AI headings; a shorter one is one section (issue #1). */
export const ARTICLE_HEADINGS_MIN_WORDS = 1000

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
		case 'page':
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
			// A page that starts right before a heading belongs to the section the heading opens.
			const last = groups.at(-1)
			const page = last?.blocks.at(-1)?.type === 'page' ? last.blocks.pop() : undefined
			const parentLimit = (groups.at(-1)?.level ?? 0) + 1
			const level = Math.max(1, Math.min(block.level - top + 1, parentLimit, MAX_SECTION_LEVEL))
			groups.push({ title: block.text, level, blocks: page ? [page] : [], wordCount: 0, aiTitle: block.source === 'ai', kind: 'body', heading: true })
			continue
		}
		if (!groups.length) groups.push({ title: fallbackTitle, level: 1, blocks: [], wordCount: 0, aiTitle: false, kind: 'body', heading: false })
		const group = groups.at(-1)!
		group.blocks.push(block)
		group.wordCount += countWords(blockText(block))
	}
	// A run of page markers alone is no section: a page break, not text.
	return groups.filter((g) => g.heading || g.blocks.some((b) => b.type !== 'page')).flatMap(({ heading: _, ...g }) => cut(g))
}

/**
 * A part of a book as its own table of contents or outline lists it. `level` is its depth in
 * that outline (1 for a part or a top-level chapter); its blocks may hold the author's headings.
 */
export type Chapter = { title: string; level: number; kind: SectionKind; blocks: Block[] }

/**
 * `chapter` is the index of the chapter a section came from. `headingsPending` marks every
 * section of a chapter that has no headings and was cut by length alone, so the AI can add
 * headings when the member opens it.
 */
export type BookSection = SectionDraft & { chapter: number; headingsPending: boolean; notes: Note[] }

/**
 * Splits a book chapter by chapter: each chapter is split like an article (issue #1), under a
 * section titled with the chapter's own title, nested at the chapter's depth in the book's
 * outline, at most three levels. A chapter with no text of its own (a part page) stays only as
 * the parent of the chapters after it.
 *
 * A body chapter with no headings is marked `headingsPending` when it is longer than
 * `headingsFrom` words: by default only chapters long enough to be cut, and for a PDF that
 * reads as one article, ARTICLE_HEADINGS_MIN_WORDS. `notes` are the book's notes; each section
 * gets the ones its markers open.
 */
export function splitBook(
	chapters: readonly Chapter[],
	{ headingsFrom = MAX_SECTION_WORDS + 1, notes = [] }: { headingsFrom?: number; notes?: readonly Note[] } = {},
): BookSection[] {
	const byId = new Map(notes.map((n) => [n.id, n]))
	// Each section keeps the notes its own markers open, so its text and notes travel together.
	const notesOf = (blocks: Block[]) => [...new Set(blocks.flatMap(noteIds))].flatMap((id) => byId.get(id) ?? [])
	return withParents(chapters).flatMap((chapter, index) => {
		const top = Math.min(6, ...chapter.blocks.flatMap((b) => (b.type === 'heading' ? [b.level] : [])))
		// The chapter's title is the top heading, so its own headings start one level below it.
		const blocks: Block[] = [
			{ type: 'heading', level: 1, text: chapter.title },
			...chapter.blocks.map((b) => (b.type === 'heading' ? { ...b, level: Math.min(6, 2 + b.level - top) } : b)),
		]
		const words = chapter.blocks.reduce((n, b) => n + countWords(blockText(b)), 0)
		const headingsPending = chapter.kind === 'body' && !hasHeadings(chapter.blocks) && words >= headingsFrom
		return splitSections(blocks, chapter.title).map((s) => ({
			...s,
			level: Math.min(MAX_SECTION_LEVEL, s.level + chapter.level - 1),
			kind: chapter.kind,
			chapter: index,
			headingsPending,
			notes: notesOf(s.blocks),
		}))
	})
}

/**
 * Leaves out chapters with no text unless they are the parent of the chapters after them, and
 * closes the gaps left in the outline, so every chapter is at most one level below the one
 * before it.
 */
function withParents(chapters: readonly Chapter[]): Chapter[] {
	const out: Chapter[] = []
	for (let i = chapters.length - 1; i >= 0; i--) {
		const c = chapters[i]!
		const empty = !c.blocks.some((b) => b.type === 'image' || blockText(b).trim())
		if (empty && !(out[0] && out[0].level > c.level)) continue
		out.unshift(c)
	}
	let previous = 0
	return out.map((c) => {
		const level = Math.max(1, Math.min(c.level, previous + 1))
		previous = level
		return { ...c, level }
	})
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
				kind: section.kind,
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
