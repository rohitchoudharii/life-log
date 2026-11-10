import { type ReadingPosition, type ReadingWithContents, SEEN_SECONDS } from '@life-log-club/contract'
import type { Block, Note, NoteRef, Link as TextLink } from '@life-log-club/domain'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { FinishCard, useFinish } from '../finish'
import { importingText } from '../readings'
import { SaveIdea } from '../save-idea'
import { client, errorMessage, orpc } from '../rpc'

type NoteMarks = { notes: Map<string, Note>; open: (note: Note) => void }

/**
 * Text with its link ranges as links that open the original page in a new tab, and its note
 * markers as small buttons that open the note.
 */
function Inline({ text, links = [], refs = [], marks }: { text: string; links?: TextLink[]; refs?: NoteRef[]; marks: NoteMarks }) {
	const cuts = [...new Set([0, text.length, ...links.flatMap((l) => [l.start, l.end]), ...refs.map((r) => r.at)])].sort((a, b) => a - b)
	const out: ReactNode[] = []
	cuts.forEach((at, i) => {
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
		out.push(
			link ? (
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

/** How far below the top of the window the text starts, under the sticky header. */
const TOP = 80

/** The place on screen: the shown section, and its first block not yet scrolled past. Null while it loads. */
function placeOnScreen(): ReadingPosition | null {
	const article = document.querySelector<HTMLElement>('article[data-section]')
	if (!article) return null
	const blocks = [...article.querySelectorAll<HTMLElement>('[data-block]')]
	const top = blocks.find((b) => b.getBoundingClientRect().bottom > TOP) ?? blocks.at(-1)
	return { sectionId: article.dataset.section!, block: Number(top?.dataset.block ?? 0) }
}

/**
 * One section's text. `startAt` is the block to open at, scrolled to once the text is shown.
 * `onEnd` runs when the member reaches its end.
 */
function SectionView({
	id,
	readingId,
	size,
	startAt,
	onEnd,
}: { id: string; readingId: string; size: string; startAt?: number; onEnd?: () => void }) {
	const queryClient = useQueryClient()
	const section = useQuery({
		...orpc.readings.section.queryOptions({ input: { id } }),
		refetchInterval: (query) => (query.state.data?.headingsPending ? 2000 : false),
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
	const loaded = Boolean(section.data)
	const opened = useRef(false)
	useEffect(() => {
		if (!loaded || opened.current) return
		opened.current = true
		if (startAt) document.querySelector(`[data-section="${id}"] [data-block="${startAt}"]`)?.scrollIntoView({ block: 'start' })
	}, [loaded, id, startAt])

	if (section.isError) return <p role="alert">{errorMessage(section.error)}</p>
	if (!section.data) return <p className="text-world-muted">Loading…</p>
	const marks: NoteMarks = { notes: new Map(section.data.notes.map((n) => [n.id, n])), open: setOpenNote }
	const note = section.data.headingsPending
		? 'Adding headings to this long chapter…'
		: section.data.kind === 'reference'
			? 'Kept to read. No recall.'
			: section.data.aiTitle
				? "Heading added by AI. The text is the author's."
				: null
	return (
		<article
			data-section={id}
			data-pending={section.data.headingsPending ? '' : undefined}
			className="grid gap-4 leading-relaxed"
			style={{ fontSize: size }}
		>
			<header>
				<h2 className="text-[1.35em] font-semibold tracking-tight">{section.data.title}</h2>
				{note && <p className={`font-sans text-xs text-world-muted ${section.data.headingsPending ? 'animate-pulse' : ''}`}>{note}</p>}
			</header>
			{section.data.blocks.map((b, i) => (
				// The block a saved position names, and where opening at it puts the top of the screen.
				<div key={i} data-block={i} style={{ scrollMarginTop: TOP }}>
					<BlockView block={b} marks={marks} />
				</div>
			))}
			{openNote && <NoteDialog note={openNote} onClose={() => setOpenNote(null)} />}
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
 * How the text is set: line width and type size. Kept in this browser, since the right choice
 * depends on the screen.
 */
const WIDTHS = { Narrow: '38rem', Medium: '46rem', Wide: '60rem' }
const SIZES = { Small: '1rem', Medium: '1.125rem', Large: '1.25rem', Larger: '1.4rem' }

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
	const [width, setWidth] = useChoice('reader-width', WIDTHS, 'Medium')
	const [size, setSize] = useChoice('reader-size', SIZES, 'Medium')
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
			void client.readings.seen({ sectionId, seconds: SEEN_SECONDS })
		}, 1000)
		return () => {
			window.clearInterval(tick)
			for (const e of events) window.removeEventListener(e, touch)
		}
	}, [sectionId])

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
	const step = 'rounded-xl border border-world-line px-4 py-2 font-sans text-sm transition hover:bg-world-card active:scale-[0.97]'

	return (
		<div className="grid gap-8 xl:grid-cols-[17rem_minmax(0,1fr)] xl:gap-12">
			<SaveIdea readingId={r.id} />
			<aside className="hidden border-r border-world-line xl:block">
				<div className="sticky top-20 grid max-h-[calc(100dvh-6.5rem)] grid-rows-[auto_minmax(0,1fr)] gap-2 pr-3">
					<p className="flex items-baseline justify-between px-2 font-sans text-xs font-semibold tracking-wide text-world-muted uppercase">
						Contents
						<span className="font-normal tracking-normal normal-case">
							{current + 1} of {r.contents.length}
						</span>
					</p>
					<nav aria-label="Contents" className="overflow-y-auto overscroll-contain pb-4">
						{contents}
					</nav>
				</div>
			</aside>
			<div className="mx-auto grid w-full gap-6" style={{ maxWidth: WIDTHS[width] }}>
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
						<div className="flex items-center gap-2">
							<Picker name="Text size" options={SIZES} value={size} onPick={setSize} label={sizeLetter} className="flex" />
							<Picker name="Text width" options={WIDTHS} value={width} onPick={setWidth} className="hidden lg:flex" />
						</div>
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
						size={SIZES[size]}
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
