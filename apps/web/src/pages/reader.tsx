import { type ReadingPosition, type ReadingWithContents, type Section, SEEN_SECONDS, type Suggestion } from '@life-log-club/contract'
import type { Block, Note, NoteRef, Link as TextLink } from '@life-log-club/domain'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { type CSSProperties, Fragment, type ReactNode, type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { FinishCard, useFinish } from '../finish'
import {
	FOCUS_AIDS,
	FOCUS_LINES,
	type FocusAid,
	FocusLine,
	type FocusLines,
	FocusPlayer,
	type Pace,
	PACER_STYLES,
	PACES,
	type PacerStyle,
	phraseStarts,
	type Rate,
	RATES,
	TOP,
	useDriftCheck,
} from '../focus'
import { importingText } from '../readings'
import { SaveIdea } from '../save-idea'
import { client, errorMessage, orpc } from '../rpc'
import { useToast } from '../toast'
import { PanelIcon } from '../ui'
import { TermDialog } from '../word-dialogs'

type NoteMarks = {
	notes: Map<string, Note>
	open: (note: Note) => void
	/** Words the AI suggests in this section, underlined faintly where their sentence is. */
	terms?: Suggestion[]
	openTerm?: (term: Suggestion) => void
	/** Sets text one phrase per line, for the Phrases reading aid. */
	phrases?: boolean
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Where each suggested word sits in a text: inside its own sentence, as a whole word, once. */
function termRanges(text: string, terms: Suggestion[] = []) {
	return terms.flatMap((term) => {
		const at = text.indexOf(term.sentence)
		if (at < 0) return []
		const m = new RegExp(`(?<![\\p{L}])${escapeRegExp(term.form)}(?![\\p{L}])`, 'u').exec(term.sentence)
		return m ? [{ start: at + m.index, end: at + m.index + term.form.length, term }] : []
	})
}

/**
 * Text with its link ranges as links that open the original page in a new tab, and its note
 * markers as small buttons that open the note.
 */
function Inline({ text, links = [], refs = [], marks }: { text: string; links?: TextLink[]; refs?: NoteRef[]; marks: NoteMarks }) {
	// A suggested word inside a link stays a link.
	const terms = termRanges(text, marks.terms).filter((t) => !links.some((l) => l.start < t.end && t.start < l.end))
	// A phrase never starts inside a suggested word, so the word stays one button.
	const phrases = marks.phrases ? phraseStarts(text).filter((p) => !terms.some((t) => t.start < p.at && p.at < t.end)) : []
	const cuts = [
		...new Set([0, text.length, ...links.flatMap((l) => [l.start, l.end]), ...refs.map((r) => r.at), ...terms.flatMap((t) => [t.start, t.end]), ...phrases.map((p) => p.at)]),
	].sort((a, b) => a - b)
	const out: ReactNode[] = []
	cuts.forEach((at, i) => {
		const phrase = phrases.find((p) => p.at === at)
		if (phrase) {
			out.push(<br key={`b${at}`} />)
			// A phrase that goes on a sentence is indented, so each sentence starts at the edge.
			if (!phrase.sentence) out.push(<span key={`i${at}`} aria-hidden className="inline-block w-[1.4em]" />)
		}
		for (const ref of refs.filter((r) => r.at === at)) {
			const note = marks.notes.get(ref.id)
			if (!note) continue
			out.push(
				<sup key={`n${at}${ref.id}`}>
					<button
						type="button"
						aria-label={`Note ${note.label}`}
						onClick={() => marks.open(note)}
						className="rounded px-0.5 font-sans text-xs font-semibold text-world-accent hover:bg-world-card focus-visible:outline-2 focus-visible:outline-world-accent"
					>
						{note.label}
					</button>
				</sup>,
			)
		}
		const end = cuts[i + 1]
		if (end === undefined || end === at) return
		const piece = text.slice(at, end)
		const link = links.find((l) => l.start <= at && end <= l.end)
		const term = terms.find((t) => t.start <= at && end <= t.end)
		out.push(
			term && marks.openTerm ? (
				<button
					key={at}
					type="button"
					aria-haspopup="dialog"
					title="A word worth knowing"
					onClick={() => marks.openTerm!(term.term)}
					className="cursor-help underline decoration-world-muted/50 decoration-dotted underline-offset-4 hover:decoration-world-accent focus-visible:outline-2 focus-visible:outline-world-accent"
				>
					{piece}
				</button>
			) : link ? (
				<a key={at} href={link.href} target="_blank" rel="noopener noreferrer nofollow" className="text-world-accent underline underline-offset-2">
					{piece}
				</a>
			) : (
				piece
			),
		)
	})
	return out
}

/** Renders our own blocks as plain elements; nothing from the original page's HTML is used. */
function BlockView({ block, marks }: { block: Block; marks: NoteMarks }) {
	switch (block.type) {
		case 'heading':
			return <h3 className="mt-6 text-[1.1em] font-semibold">{block.text}</h3>
		case 'paragraph':
			return (
				<p>
					<Inline text={block.text} links={block.links} refs={block.notes} marks={marks} />
				</p>
			)
		case 'quote':
			return (
				<blockquote className="border-l-2 border-world-line pl-4 italic">
					<Inline text={block.text} links={block.links} refs={block.notes} marks={marks} />
				</blockquote>
			)
		case 'code':
			return (
				<pre className="overflow-x-auto rounded-xl bg-world-card p-4 font-mono text-[0.8em] leading-relaxed whitespace-pre-wrap ring-1 ring-world-line">
					<code>{block.text}</code>
				</pre>
			)
		case 'list': {
			const List = block.ordered ? 'ol' : 'ul'
			return (
				<List className={`grid gap-1 pl-6 ${block.ordered ? 'list-decimal' : 'list-disc'}`}>
					{block.items.map((item, i) => (
						<li key={i}>
							<Inline text={item} links={block.links?.filter((l) => l.item === i)} refs={block.notes?.filter((n) => n.item === i)} marks={marks} />
						</li>
					))}
				</List>
			)
		}
		case 'table': {
			const [first = [], ...rest] = block.rows
			const body = block.header ? rest : block.rows
			const cell = 'border-b border-world-line px-3 py-2 align-top'
			return (
				// Wide tables scroll inside their own box, so the page never scrolls sideways.
				<div className="overflow-x-auto rounded-xl bg-world-card ring-1 ring-world-line">
					<table className="w-full border-collapse font-sans text-[0.8em] leading-snug">
						{block.header && (
							<thead>
								<tr>
									{first.map((text, i) => (
										<th key={i} scope="col" className={`${cell} text-left font-semibold`}>
											{text}
										</th>
									))}
								</tr>
							</thead>
						)}
						<tbody className="[&>tr:last-child>td]:border-b-0">
							{body.map((row, r) => (
								<tr key={r}>
									{row.map((text, i) => (
										<td key={i} className={`${cell} min-w-32 lg:min-w-0`}>
											{text}
										</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)
		}
		case 'image':
			if (block.mediaId)
				return (
					<figure className="my-2">
						<img src={`/media/${block.mediaId}`} alt={block.alt} width={block.width} height={block.height} loading="lazy" className="mx-auto h-auto max-w-full rounded-lg" />
					</figure>
				)
			// An image that wasn't stored keeps its description in place.
			return block.alt ? <p className="font-sans text-[0.8em] text-world-muted italic">Image: {block.alt}</p> : null
		case 'page':
			return <p className="font-sans text-xs text-world-muted">p. {block.number}</p>
	}
}

/** A footnote or endnote, over the text it belongs to. Esc, Close, or a click outside closes it. */
function NoteDialog({ note, onClose }: { note: Note; onClose: () => void }) {
	const ref = useRef<HTMLDialogElement>(null)
	useEffect(() => {
		ref.current?.showModal()
	}, [])
	const none: NoteMarks = { notes: new Map(), open: () => {} }
	return (
		<dialog
			ref={ref}
			aria-label={`Note ${note.label}`}
			onClose={onClose}
			onClick={(e) => e.target === ref.current && onClose()}
			className="m-auto w-[min(100%-2rem,36rem)] rounded-2xl bg-world p-0 font-world text-world-ink shadow-2xl ring-1 ring-world-line backdrop:bg-black/30"
		>
			<div className="grid gap-3 p-5 text-base leading-relaxed">
				<div className="flex items-center justify-between font-sans">
					<p className="text-sm font-semibold">Note {note.label}</p>
					<button type="button" onClick={onClose} className="rounded-lg px-2 py-1 text-sm text-world-muted hover:bg-world-card">
						Close <kbd className="ml-1 rounded border border-world-line px-1 text-xs">Esc</kbd>
					</button>
				</div>
				{note.blocks.map((b, i) => (
					<BlockView key={i} block={b} marks={none} />
				))}
			</div>
		</dialog>
	)
}

/** Esc or a click outside `box` closes an open menu, as menus do. */
function useDismiss(box: RefObject<HTMLElement | null>, open: boolean, setOpen: (open: boolean) => void) {
	useEffect(() => {
		if (!open) return
		const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
		const onDown = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false)
		window.addEventListener('keydown', onKey)
		window.addEventListener('pointerdown', onDown)
		return () => {
			window.removeEventListener('keydown', onKey)
			window.removeEventListener('pointerdown', onDown)
		}
	}, [box, open, setOpen])
}

/**
 * The section's menu: Rewrite questions, and Rewrite key ideas while none of them is in use. A
 * rewrite runs in the background; the line under the title follows it, and every answer and
 * schedule is kept.
 */
function SectionMenu({ section }: { section: Section }) {
	const queryClient = useQueryClient()
	const toast = useToast()
	const [open, setOpen] = useState(false)
	const [asked, setAsked] = useState<'questions' | 'ideas' | null>(null)
	const rewrite = useMutation({
		mutationFn: (ideas: boolean) => client.questions.rewrite({ sectionId: section.id, ideas }),
		onSuccess: (_, ideas) => {
			setAsked(ideas ? 'ideas' : 'questions')
			setOpen(false)
			// The server queued it; showing that at once starts the polling and the line under the title.
			queryClient.setQueryData(orpc.readings.section.queryKey({ input: { id: section.id } }), (old) => old && { ...old, writeStatus: 'queued' as const })
		},
	})
	const busy = section.writeStatus === 'queued' || section.writeStatus === 'writing'
	// Says when the rewrite the member asked for is done, once: after the section was seen busy with it.
	const seenBusy = useRef(false)
	useEffect(() => {
		if (!asked) return
		if (busy) {
			seenBusy.current = true
			return
		}
		if (!seenBusy.current) return
		if (section.writeStatus === 'ready') toast({ text: asked === 'ideas' ? 'Key ideas and questions written again.' : 'New questions are ready. Your answers so far are kept.' })
		seenBusy.current = false
		setAsked(null)
	}, [asked, busy, section.writeStatus, toast])
	const box = useRef<HTMLDivElement>(null)
	useDismiss(box, open, setOpen)
	const item = 'block w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-world disabled:opacity-50'
	return (
		<div ref={box} className="relative font-sans">
			<button
				type="button"
				aria-label="Section menu"
				aria-expanded={open}
				onClick={() => setOpen((o) => !o)}
				className="grid size-8 place-items-center rounded-lg text-world-muted transition hover:bg-world-card hover:text-world-ink"
			>
				<span aria-hidden className="text-lg leading-none">⋯</span>
			</button>
			{open && (
				<div role="menu" className="absolute right-0 z-20 mt-1 grid w-64 gap-0.5 rounded-xl bg-world-card p-1.5 shadow-lg ring-1 ring-world-line">
					<button type="button" role="menuitem" className={item} disabled={busy || rewrite.isPending} onClick={() => rewrite.mutate(false)}>
						<span className="font-medium">Rewrite questions</span>
						<span className="block text-xs text-world-muted">New questions on the same key ideas. Your answers and schedule stay.</span>
					</button>
					{!section.ideasInUse && (
						<button type="button" role="menuitem" className={item} disabled={busy || rewrite.isPending} onClick={() => rewrite.mutate(true)}>
							<span className="font-medium">Rewrite key ideas</span>
							<span className="block text-xs text-world-muted">Find the key ideas again. Only before you answer any of them.</span>
						</button>
					)}
					{rewrite.error && (
						<p role="alert" className="px-3 py-2 text-sm text-red">
							{errorMessage(rewrite.error)}
						</p>
					)}
				</div>
			)}
		</div>
	)
}

/** Calls `onEnd` once, when the end of the text comes into view. */
function EndMark({ onEnd }: { onEnd: () => void }) {
	const mark = useRef<HTMLDivElement>(null)
	const done = useRef(onEnd)
	done.current = onEnd
	useEffect(() => {
		const observer = new IntersectionObserver((seen) => {
			if (!seen.some((e) => e.isIntersecting)) return
			observer.disconnect()
			done.current()
		})
		if (mark.current) observer.observe(mark.current)
		return () => observer.disconnect()
	}, [])
	return <div ref={mark} aria-hidden className="h-px" />
}

/**
 * The index card at the end of a section: Recall this section opens the brain dump at once, while
 * any key ideas not written yet are written. The R key does the same. At the last section of a
 * chapter with more than one, Recall chapter does the same for all of `chapter`.
 */
function RecallCard({ readingId, sectionId, chapter }: { readingId: string; sectionId: string; chapter: string[] | null }) {
	const navigate = useNavigate()
	const start = useMutation({
		mutationFn: (sectionIds: string[]) => client.recall.start({ id: crypto.randomUUID(), readingId, sectionIds }),
		onSuccess: (attempt) => navigate({ to: '/mind/recall/$attemptId', params: { attemptId: attempt.id } }),
	})
	const go = useRef(start.mutate)
	go.current = start.mutate
	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || (e.key !== 'r' && e.key !== 'R')) return
			if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"], dialog')) return
			e.preventDefault()
			go.current([sectionId])
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [sectionId])
	return (
		<div className="grid gap-3 rounded-2xl border border-world-line bg-world-card p-5 shadow-sm">
			<p className="font-sans text-xs font-semibold tracking-wide text-world-muted uppercase">{chapter ? 'End of chapter' : 'End of section'}</p>
			<p className="text-lg">Close the text and write down what you remember.</p>
			<div className="flex flex-wrap items-center gap-3">
				<button
					type="button"
					disabled={start.isPending}
					onClick={() => start.mutate([sectionId])}
					className="rounded-xl bg-world-accent px-5 py-2 font-sans text-sm font-semibold text-world-on-accent transition hover:opacity-90 disabled:opacity-60"
				>
					Recall this section
				</button>
				{chapter && (
					<button
						type="button"
						disabled={start.isPending}
						onClick={() => start.mutate(chapter)}
						className="rounded-xl border border-world-line px-5 py-2 font-sans text-sm font-semibold transition hover:bg-world disabled:opacity-60"
					>
						Recall chapter
					</button>
				)}
				<span className="hidden font-sans text-xs text-world-muted md:inline">
					or press <kbd>R</kbd>
				</span>
			</div>
			{start.error && <p role="alert" className="font-sans text-sm text-red">{errorMessage(start.error)}</p>}
		</div>
	)
}

/**
 * The sections to recall together when `sectionId` is the last one with words in its chapter and
 * the chapter has more than one; otherwise null. An article is all chapter 0, so it has none.
 */
function chapterToRecall(contents: ReadingWithContents['contents'], sectionId: string) {
	if (!contents.some((s) => s.chapter > 0)) return null
	const here = contents.find((s) => s.id === sectionId)
	const chapter = contents.filter((s) => s.chapter === here?.chapter && s.kind === 'body' && s.wordCount > 0)
	return chapter.length > 1 && chapter.at(-1)?.id === sectionId ? chapter.map((s) => s.id) : null
}

function FinishButton({ reading, onDone }: { reading: ReadingWithContents; onDone: () => void }) {
	const finish = useFinish(reading, onDone)
	return (
		<button
			type="button"
			disabled={finish.isPending}
			onClick={() => finish.mutate()}
			className="rounded-xl border border-world-line px-3 py-1.5 font-sans text-sm transition hover:bg-world-card active:scale-[0.97]"
		>
			Finished
		</button>
	)
}

/** The place on screen: the shown section, and its first block not yet scrolled past. Null while it loads. */
function placeOnScreen(): ReadingPosition | null {
	const article = document.querySelector<HTMLElement>('article[data-section]')
	if (!article) return null
	const blocks = [...article.querySelectorAll<HTMLElement>('[data-block]')]
	const top = blocks.find((b) => b.getBoundingClientRect().bottom > TOP) ?? blocks.at(-1)
	return { sectionId: article.dataset.section!, block: Number(top?.dataset.block ?? 0) }
}

const NO_BLOCKS: Block[] = []

/**
 * One section's text, with the reading aid `settings` picks. `startAt` is the block to open at,
 * scrolled to once the text is shown. `onEnd` runs when the member reaches its end.
 */
function SectionView({
	id,
	readingId,
	textStyle,
	settings,
	startAt,
	onEnd,
}: { id: string; readingId: string; textStyle: CSSProperties; settings: ReadingSettings; startAt?: number; onEnd?: () => void }) {
	const queryClient = useQueryClient()
	const section = useQuery({
		...orpc.readings.section.queryOptions({ input: { id } }),
		// While headings are added, or questions rewritten, the section changes on its own.
		refetchInterval: (query) => {
			const data = query.state.data
			return data?.headingsPending || (data && ['queued', 'writing'].includes(data.writeStatus)) ? 2000 : false
		},
	})
	// Once the AI's headings are in, the chapter is split differently, so the contents change too.
	const pending = section.data?.headingsPending
	const wasPending = useRef(false)
	useEffect(() => {
		if (wasPending.current && pending === false)
			void queryClient.invalidateQueries({ queryKey: orpc.readings.get.queryKey({ input: { id: readingId } }) })
		wasPending.current = pending === true
	}, [pending, queryClient, readingId])

	const [openNote, setOpenNote] = useState<Note | null>(null)
	// Words worth knowing come with the key ideas, once the section is written.
	const suggested = useQuery({ ...orpc.words.suggestions.queryOptions({ input: { sectionId: id } }), enabled: section.data?.writeStatus === 'ready' })
	const [openTerm, setOpenTerm] = useState<Suggestion | null>(null)
	const text = useRef<HTMLDivElement>(null)
	const driftCheck = useDriftCheck(section.data?.blocks ?? NO_BLOCKS, settings.aid === 'Drift check', text)
	const loaded = Boolean(section.data)
	const opened = useRef(false)
	useEffect(() => {
		if (!loaded || opened.current) return
		opened.current = true
		if (startAt) document.querySelector(`[data-section="${id}"] [data-block="${startAt}"]`)?.scrollIntoView({ block: 'start' })
	}, [loaded, id, startAt])

	if (section.isError) return <p role="alert">{errorMessage(section.error)}</p>
	if (!section.data) return <p className="text-world-muted">Loading…</p>
	const marks: NoteMarks = {
		notes: new Map(section.data.notes.map((n) => [n.id, n])),
		open: setOpenNote,
		terms: suggested.data,
		openTerm: setOpenTerm,
		phrases: settings.aid === 'Phrases',
	}
	const rewriting = ['queued', 'writing'].includes(section.data.writeStatus)
	const note = section.data.headingsPending
		? 'Adding headings to this long chapter…'
		: rewriting && section.data.keyIdeas > 0
			? 'Rewriting questions for this section…'
			: section.data.writeStatus === 'failed' && section.data.keyIdeas > 0
				? 'Rewriting the questions failed. Try again from the section menu.'
		: section.data.kind === 'reference'
			? 'Kept to read. No recall.'
			: section.data.aiTitle
				? "Heading added by AI. The text is the author's."
				: null
	return (
		<article
			data-section={id}
			data-pending={section.data.headingsPending ? '' : undefined}
			className="grid gap-4"
			style={textStyle}
		>
			<header>
				<div className="flex items-start justify-between gap-3">
					<h2 className="text-[1.35em] font-semibold tracking-tight">{section.data.title}</h2>
					{(section.data.keyIdeas > 0 || rewriting) && <SectionMenu section={section.data} />}
				</div>
				{note && <p className={`font-sans text-xs text-world-muted ${section.data.headingsPending || rewriting ? 'animate-pulse' : ''}`}>{note}</p>}
			</header>
			<div ref={text} className="relative grid gap-4">
				{section.data.blocks.map((b, i) => (
					<Fragment key={i}>
						{/* The block a saved position names, and where opening at it puts the top of the screen. */}
						<div data-block={i} style={{ scrollMarginTop: TOP }}>
							<BlockView block={b} marks={marks} />
						</div>
						{driftCheck(i)}
					</Fragment>
				))}
				{settings.aid === 'Focus line' && <FocusLine root={text} span={Number(FOCUS_LINES[settings.lines])} />}
			</div>
			{(settings.aid === 'Pacer' || settings.aid === 'Read aloud') && (
				// Keyed, so switching between them starts afresh, without the other's mark or place.
				<FocusPlayer
					key={settings.aid}
					root={text}
					aid={settings.aid}
					style={settings.pacerStyle}
					pace={settings.pace}
					setPace={settings.setPace}
					rate={settings.rate}
					setRate={settings.setRate}
				/>
			)}
			{openNote && <NoteDialog note={openNote} onClose={() => setOpenNote(null)} />}
			{openTerm && <TermDialog term={openTerm} sectionId={id} onClose={() => setOpenTerm(null)} />}
			{onEnd && <EndMark key={id} onEnd={onEnd} />}
		</article>
	)
}

/** A section's title and text, to read beside something else, such as a brain dump. */
export function SectionText({ id }: { id: string }) {
	const section = useQuery(orpc.readings.section.queryOptions({ input: { id } }))
	const [openNote, setOpenNote] = useState<Note | null>(null)
	if (section.isError) return <p role="alert">{errorMessage(section.error)}</p>
	if (!section.data) return <p className="text-world-muted">Loading…</p>
	const marks: NoteMarks = { notes: new Map(section.data.notes.map((n) => [n.id, n])), open: setOpenNote }
	return (
		<article className="grid gap-3 leading-relaxed">
			<h2 className="text-xl font-semibold tracking-tight">{section.data.title}</h2>
			{section.data.blocks.map((b, i) => (
				<BlockView key={i} block={b} marks={marks} />
			))}
			{openNote && <NoteDialog note={openNote} onClose={() => setOpenNote(null)} />}
		</article>
	)
}

function Contents({ reading, current, onPick }: { reading: ReadingWithContents; current: number; onPick: (i: number) => void }) {
	return (
		<ol className="grid gap-0.5 font-sans text-sm">
			{reading.contents.map((s, i) => (
				<li key={s.id} style={{ paddingLeft: `${(s.level - 1) * 0.9}rem` }}>
					<button
						type="button"
						aria-current={i === current ? 'true' : undefined}
						onClick={() => onPick(i)}
						className="w-full rounded-md px-2 py-1 text-left text-world-muted hover:bg-world-card hover:text-world-ink aria-[current]:bg-world-card aria-[current]:font-semibold aria-[current]:text-world-ink"
					>
						<span className={s.aiTitle ? 'italic' : undefined}>{s.title}</span>
						{s.kind === 'reference' && <span className="ml-1.5 text-xs text-world-muted">· Reference</span>}
					</button>
				</li>
			))}
		</ol>
	)
}

/**
 * How the text is set: type size, line width, line spacing and typeface. Kept in this browser,
 * since the right choice depends on the screen.
 */
const WIDTHS = { Narrow: '43.7rem', Medium: '52.9rem', Wide: '69rem' }
const SIZES = { Small: '1rem', Medium: '1.125rem', Large: '1.25rem', Larger: '1.4rem' }
const SPACINGS = { Tight: '1.45', Normal: '1.625', Loose: '1.9' }
// Fonts the device already has, so no download slows the first page. Each stack falls back to a near match on other systems.
const FACES = {
	Serif: 'var(--font-serif)',
	Charter: "Charter, 'Bitstream Charter', 'Sitka Text', Cambria, serif",
	Georgia: "Georgia, 'Times New Roman', serif",
	Sans: 'ui-sans-serif, system-ui, sans-serif',
	Humanist: "Seravek, 'Gill Sans Nova', Ubuntu, Calibri, 'DejaVu Sans', sans-serif",
	Rounded: 'var(--font-rounded)',
}
/** Whether the contents sit beside the text on a wide screen, or fold away. */
const CONTENTS = { Shown: 'shown', Hidden: 'hidden' }

function useChoice<T extends string>(key: string, options: Record<T, string>, fallback: T) {
	const [choice, setChoice] = useState<T>(() => {
		const saved = localStorage.getItem(key)
		return saved && saved in options ? (saved as T) : fallback
	})
	return [
		choice,
		(c: T) => {
			localStorage.setItem(key, c)
			setChoice(c)
		},
	] as const
}

function useReadingSettings() {
	const [size, setSize] = useChoice('reader-size', SIZES, 'Medium')
	const [width, setWidth] = useChoice('reader-width', WIDTHS, 'Medium')
	const [spacing, setSpacing] = useChoice('reader-spacing', SPACINGS, 'Normal')
	const [face, setFace] = useChoice('reader-face', FACES, 'Serif')
	const [aid, setAid] = useChoice<FocusAid>('reader-aid', FOCUS_AIDS, 'Off')
	const [lines, setLines] = useChoice<FocusLines>('reader-focus-lines', FOCUS_LINES, '1 line')
	const [pace, setPace] = useChoice<Pace>('reader-pace', PACES, '220')
	const [pacerStyle, setPacerStyle] = useChoice<PacerStyle>('reader-pacer-style', PACER_STYLES, 'Steady line')
	const [rate, setRate] = useChoice<Rate>('reader-rate', RATES, '1')
	return { size, setSize, width, setWidth, spacing, setSpacing, face, setFace, aid, setAid, lines, setLines, pacerStyle, setPacerStyle, pace, setPace, rate, setRate }
}
type ReadingSettings = ReturnType<typeof useReadingSettings>

/** One click picks an option. `label` draws each one; its name is the option's. */
function Picker<T extends string>({
	name,
	options,
	value,
	onPick,
	label = (o) => o,
	className = '',
}: { name: string; options: Record<T, string>; value: T; onPick: (o: T) => void; label?: (o: T) => ReactNode; className?: string }) {
	return (
		<div role="group" aria-label={name} className={`items-center gap-0.5 rounded-lg border border-world-line p-0.5 font-sans text-xs ${className}`}>
			{(Object.keys(options) as T[]).map((o) => (
				<button
					key={o}
					type="button"
					aria-label={o}
					aria-pressed={o === value}
					onClick={() => onPick(o)}
					className="grid h-7 min-w-7 place-items-center rounded-md px-2 text-world-muted transition hover:text-world-ink aria-pressed:bg-world-card aria-pressed:font-semibold aria-pressed:text-world-ink aria-pressed:shadow-sm"
				>
					{label(o)}
				</button>
			))}
		</div>
	)
}

// The letter grows with the size it picks, so the buttons need no words.
const sizeLetter = (s: keyof typeof SIZES) => (
	<span aria-hidden className="font-serif leading-none" style={{ fontSize: `calc(${SIZES[s]} * 0.8)` }}>
		A
	</span>
)

/** The Aa button, and the panel under it that sets the text. Each choice applies at once. */
function ReadingSettings({ settings: s }: { settings: ReadingSettings }) {
	const [open, setOpen] = useState(false)
	const box = useRef<HTMLDivElement>(null)
	useDismiss(box, open, setOpen)
	const row = 'grid gap-1.5'
	const name = 'text-xs font-semibold text-world-muted'
	const picker = 'grid auto-cols-fr grid-flow-col'
	return (
		<div ref={box} className="relative font-sans">
			<button
				type="button"
				aria-label="Reading settings"
				title="Reading settings"
				aria-expanded={open}
				onClick={() => setOpen((o) => !o)}
				className="grid h-8 place-items-center rounded-lg border border-world-line px-2.5 text-world-muted transition hover:bg-world-card hover:text-world-ink aria-expanded:bg-world-card aria-expanded:text-world-ink"
			>
				<span aria-hidden className="font-serif text-base leading-none">
					A<span className="text-[0.8em]">a</span>
				</span>
			</button>
			{open && (
				// Above the Pacer's bar, which would otherwise cover the Pacer style on a phone.
				<div role="group" aria-label="Reading settings" className="absolute right-0 z-40 mt-1 grid w-72 gap-4 rounded-xl bg-world-card p-4 shadow-lg ring-1 ring-world-line">
					<div className={row}>
						<p className={name}>Text size</p>
						<Picker name="Text size" options={SIZES} value={s.size} onPick={s.setSize} label={sizeLetter} className={picker} />
					</div>
					{/* On a narrower screen the text already fills it, so width does nothing there. */}
					<div className={`${row} hidden lg:grid`}>
						<p className={name}>Text width</p>
						<Picker name="Text width" options={WIDTHS} value={s.width} onPick={s.setWidth} className={picker} />
					</div>
					<div className={row}>
						<p className={name}>Line spacing</p>
						<Picker name="Line spacing" options={SPACINGS} value={s.spacing} onPick={s.setSpacing} className={picker} />
					</div>
					<div className={row}>
						<p className={name}>Typeface</p>
						<Picker
							name="Typeface"
							options={FACES}
							value={s.face}
							onPick={s.setFace}
							label={(f) => <span style={{ fontFamily: FACES[f] }}>{f}</span>}
							className="grid grid-cols-3"
						/>
					</div>
					<div className={`${row} border-t border-world-line pt-4`}>
						<p className={name}>Reading aid</p>
						<Picker name="Reading aid" options={FOCUS_AIDS} value={s.aid} onPick={s.setAid} className="grid grid-cols-3" />
						<p className="text-xs leading-snug text-world-muted">{FOCUS_AIDS[s.aid]}</p>
					</div>
					{s.aid === 'Focus line' && (
						<div className={row}>
							<p className={name}>Lines in focus</p>
							<Picker name="Lines in focus" options={FOCUS_LINES} value={s.lines} onPick={s.setLines} className={picker} />
						</div>
					)}
					{s.aid === 'Pacer' && (
						<div className={row}>
							<p className={name}>Pacer style</p>
							<Picker name="Pacer style" options={PACER_STYLES} value={s.pacerStyle} onPick={s.setPacerStyle} className="grid grid-cols-2" />
							<p className="text-xs leading-snug text-world-muted">{PACER_STYLES[s.pacerStyle]}</p>
						</div>
					)}
				</div>
			)}
		</div>
	)
}

/**
 * One reading: its contents, and one section at a time. It opens where the member stopped, or at
 * `at` when given, such as the passage of a saved idea.
 */
export function Reader({ readingId, at: openAt }: { readingId: string; at?: ReadingPosition }) {
	const navigate = useNavigate()
	const reading = useQuery({
		...orpc.readings.get.queryOptions({ input: { id: readingId } }),
		refetchInterval: (query) => (query.state.data?.status === 'importing' ? 1500 : false),
	})
	const [current, setCurrent] = useState(0)
	const [contentsOpen, setContentsOpen] = useState(false)
	const settings = useReadingSettings()
	const [contentsShown, setContentsShown] = useChoice<keyof typeof CONTENTS>('reader-contents', CONTENTS, 'Shown')
	const queryClient = useQueryClient()
	// Reaching the end of a section marks it read; the end of the last one marks the reading read, which a book counts.
	const markRead = useMutation({
		mutationFn: (at: { id: string; sectionId: string }) => client.readings.markRead(at),
		onSuccess: () =>
			Promise.all([queryClient.invalidateQueries({ queryKey: orpc.readings.key() }), queryClient.invalidateQueries({ queryKey: orpc.books.key() })]),
	})
	// The same query SectionView makes: a web book's section opens the page it came from.
	const sectionId = reading.data?.status === 'ready' ? reading.data.contents[current]?.id : undefined
	const shown = useQuery({ ...orpc.readings.section.queryOptions({ input: { id: sectionId ?? '' } }), enabled: Boolean(sectionId) })
	const readyId = reading.data?.status === 'ready' ? reading.data.id : undefined

	// Opens where the member stopped. It waits for a fresh copy of the reading, because the cached
	// one may hold a position from before the member last read on. Placed before paint, so the
	// first section doesn't flash on screen.
	const [start, setStart] = useState<ReadingPosition | null>(null)
	const placed = useRef(false)
	useLayoutEffect(() => {
		const data = reading.data
		if (placed.current || data?.status !== 'ready' || !reading.isFetchedAfterMount) return
		placed.current = true
		const at = (openAt && data.contents.some((s) => s.id === openAt.sectionId) ? openAt : null) ?? data.position
		const i = at ? data.contents.findIndex((s) => s.id === at.sectionId) : -1
		// Opening counts as reading it, so Reading now lists it first, even before the member scrolls.
		const first = data.contents[0]
		const place = i >= 0 ? at : first && { sectionId: first.id, block: 0 }
		if (place) void client.readings.savePosition({ id: data.id, ...place })
		if (i < 0) return
		setCurrent(i)
		setStart(at)
	}, [reading.data, reading.isFetchedAfterMount, openAt])

	// Saves the place 2 seconds after scrolling stops. Two tabs open: the last save wins.
	useEffect(() => {
		if (!readyId) return
		let timer: number | undefined
		const onScroll = () => {
			window.clearTimeout(timer)
			timer = window.setTimeout(() => {
				const at = placeOnScreen()
				if (at) void client.readings.savePosition({ id: readyId, ...at })
			}, 2000)
		}
		window.addEventListener('scroll', onScroll, { passive: true })
		return () => {
			window.clearTimeout(timer)
			window.removeEventListener('scroll', onScroll)
		}
	}, [readyId])

	// A heartbeat for every SEEN_SECONDS the member spends in a section with some activity (a
	// scroll, a key or the pointer in the last minute). The first one marks the section seen.
	useEffect(() => {
		if (!sectionId) return
		let lastActive = Date.now()
		let active = 0
		const touch = () => {
			lastActive = Date.now()
		}
		const events = ['scroll', 'keydown', 'pointermove', 'pointerdown'] as const
		for (const e of events) window.addEventListener(e, touch, { passive: true })
		const tick = window.setInterval(() => {
			if (document.hidden || Date.now() - lastActive > 60_000) return
			active += 1
			if (active < SEEN_SECONDS) return
			active = 0
			// The first heartbeat queues the section's writing; the section then follows it until its key ideas and words are in.
			void client.readings
				.seen({ sectionId, seconds: SEEN_SECONDS })
				.then(() => queryClient.invalidateQueries({ queryKey: orpc.readings.section.queryKey({ input: { id: sectionId } }) }))
		}, 1000)
		return () => {
			window.clearInterval(tick)
			for (const e of events) window.removeEventListener(e, touch)
		}
	}, [sectionId, queryClient])

	// A link that turned out to be a page the member already has opens that reading.
	const keptId = reading.data?.id
	useEffect(() => {
		if (keptId && keptId !== readingId) void navigate({ to: '/mind/read/$readingId', params: { readingId: keptId }, replace: true })
	}, [keptId, readingId, navigate])

	if (reading.isError) return <p role="alert">{errorMessage(reading.error)}</p>
	if (!reading.data) return null
	const r = reading.data
	if (r.status !== 'ready')
		return (
			<div className="grid gap-2">
				<Link to="/mind" className="font-sans text-sm text-world-muted">
					← Reading room
				</Link>
				<h1 className="text-2xl">{r.progress ? r.title : r.requestedUrl}</h1>
				{r.status === 'importing' ? <p className="animate-pulse text-world-muted">{importingText(r)}</p> : <p role="alert">{r.error}</p>}
			</div>
		)

	const section = r.contents[current]
	const original = shown.data?.sourceUrl ?? r.sourceUrl
	const pick = (i: number) => {
		setCurrent(i)
		setStart(null)
		setContentsOpen(false)
		window.scrollTo({ top: 0 })
		const to = r.contents[i]
		if (to) void client.readings.savePosition({ id: r.id, sectionId: to.id, block: 0 })
	}
	const contents = <Contents reading={r} current={current} onPick={pick} />
	const textStyle = { fontSize: SIZES[settings.size], lineHeight: SPACINGS[settings.spacing], fontFamily: FACES[settings.face] }
	const fold = 'grid size-7 place-items-center rounded-md text-world-muted transition hover:bg-world-card hover:text-world-ink'
	const step = 'rounded-xl border border-world-line px-4 py-2 font-sans text-sm transition hover:bg-world-card active:scale-[0.97]'

	return (
		<div className={`grid gap-8 xl:gap-12 ${contentsShown === 'Shown' ? 'xl:grid-cols-[17rem_minmax(0,1fr)]' : 'xl:grid-cols-[2.5rem_minmax(0,1fr)]'}`}>
			<SaveIdea readingId={r.id} />
			<aside className="hidden border-r border-world-line xl:block">
				{contentsShown === 'Shown' ? (
					<div className="sticky top-20 grid max-h-[calc(100dvh-6.5rem)] grid-rows-[auto_minmax(0,1fr)] gap-2 pr-3">
						<div className="flex items-center gap-2 pl-2 font-sans text-xs text-world-muted">
							<p className="mr-auto font-semibold tracking-wide uppercase">Contents</p>
							<span>
								{current + 1} of {r.contents.length}
							</span>
							<button type="button" aria-label="Hide contents" title="Hide contents" onClick={() => setContentsShown('Hidden')} className={fold}>
								<PanelIcon open />
							</button>
						</div>
						<nav aria-label="Contents" className="overflow-y-auto overscroll-contain pb-4">
							{contents}
						</nav>
					</div>
				) : (
					<div className="sticky top-20 grid justify-items-start gap-1 font-sans text-xs text-world-muted">
						<button type="button" aria-label="Show contents" title={`Show contents · ${current + 1} of ${r.contents.length}`} onClick={() => setContentsShown('Shown')} className={fold}>
							<PanelIcon open={false} />
						</button>
					</div>
				)}
			</aside>
			<div className="mx-auto grid w-full gap-6" style={{ maxWidth: WIDTHS[settings.width] }}>
				<header className="grid gap-2">
					{r.book ? (
						<Link to="/mind/book/$bookId" params={{ bookId: r.book.id }} className="font-sans text-sm text-world-muted">
							← {r.book.title}
						</Link>
					) : (
						<Link to="/mind" className="font-sans text-sm text-world-muted">
							← Reading room
						</Link>
					)}
					<div className="flex flex-wrap items-start justify-between gap-3">
						<h1 className="text-3xl font-semibold tracking-tight md:text-4xl">{r.title}</h1>
						{/* Finishing is allowed without reading every section; it opens the last one, where the milestone is. */}
						{!r.finishedAt && <FinishButton reading={r} onDone={() => pick(r.contents.length - 1)} />}
					</div>
					<div className="flex flex-wrap items-center justify-between gap-2">
						<p className="font-sans text-sm text-world-muted">
							{r.author && `${r.author}${original ? ' · ' : ''}`}
							{original && (
								<a href={original} target="_blank" rel="noopener noreferrer nofollow" className="underline underline-offset-2">
									Open original
								</a>
							)}
						</p>
						<ReadingSettings settings={settings} />
					</div>
				</header>
				<div className="xl:hidden">
					<button type="button" className={step} aria-expanded={contentsOpen} onClick={() => setContentsOpen((o) => !o)}>
						Contents · {current + 1} of {r.contents.length}
					</button>
					{contentsOpen && (
						<nav aria-label="Contents" className="mt-2 rounded-2xl border border-world-line bg-world-card p-2">
							{contents}
						</nav>
					)}
				</div>
				{section && (
					<SectionView
						key={section.id}
						id={section.id}
						readingId={r.id}
						textStyle={textStyle}
						settings={settings}
						startAt={start?.sectionId === section.id ? start.block : undefined}
						onEnd={!section.readAt && !markRead.isPending ? () => markRead.mutate({ id: r.id, sectionId: section.id }) : undefined}
					/>
				)}
				{section && section.kind === 'body' && section.wordCount > 0 && <RecallCard readingId={r.id} sectionId={section.id} chapter={chapterToRecall(r.contents, section.id)} />}
				{current === r.contents.length - 1 && <FinishCard reading={r} />}
				<div className="flex justify-between gap-2">
					{current > 0 ? (
						<button type="button" className={step} onClick={() => pick(current - 1)}>
							Previous section
						</button>
					) : (
						<span />
					)}
					{current < r.contents.length - 1 && (
						<button type="button" className={step} onClick={() => pick(current + 1)}>
							Next section
						</button>
					)}
				</div>
			</div>
		</div>
	)
}
