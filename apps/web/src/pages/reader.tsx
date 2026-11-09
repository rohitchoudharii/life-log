import type { ReadingWithContents } from '@life-log-club/contract'
import type { Block, Note, NoteRef, Link as TextLink } from '@life-log-club/domain'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { importingText } from '../readings'
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
			return <h3 className="mt-6 text-xl font-semibold">{block.text}</h3>
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
				<pre className="overflow-x-auto rounded-xl bg-world-card p-4 font-mono text-sm leading-relaxed whitespace-pre-wrap ring-1 ring-world-line">
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
		case 'image':
			if (block.mediaId)
				return (
					<figure className="my-2">
						<img src={`/media/${block.mediaId}`} alt={block.alt} width={block.width} height={block.height} loading="lazy" className="mx-auto h-auto max-w-full rounded-lg" />
					</figure>
				)
			// An image that wasn't stored keeps its description in place.
			return block.alt ? <p className="font-sans text-sm text-world-muted italic">Image: {block.alt}</p> : null
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

/** One section's text. `onEnd` runs when the member reaches its end, once its text is shown. */
function SectionView({ id, readingId, onEnd }: { id: string; readingId: string; onEnd?: () => void }) {
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
		<article className="grid gap-4 text-lg leading-relaxed">
			<header>
				<h2 className="text-2xl font-semibold tracking-tight">{section.data.title}</h2>
				{note && <p className={`font-sans text-xs text-world-muted ${section.data.headingsPending ? 'animate-pulse' : ''}`}>{note}</p>}
			</header>
			{section.data.blocks.map((b, i) => (
				<BlockView key={i} block={b} marks={marks} />
			))}
			{openNote && <NoteDialog note={openNote} onClose={() => setOpenNote(null)} />}
			{onEnd && <EndMark key={id} onEnd={onEnd} />}
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

/** One reading: its contents, and one section at a time. */
export function Reader({ readingId }: { readingId: string }) {
	const navigate = useNavigate()
	const reading = useQuery({
		...orpc.readings.get.queryOptions({ input: { id: readingId } }),
		refetchInterval: (query) => (query.state.data?.status === 'importing' ? 1500 : false),
	})
	const [current, setCurrent] = useState(0)
	const [contentsOpen, setContentsOpen] = useState(false)
	const queryClient = useQueryClient()
	// Reaching the end of the last section marks the reading read, which a book counts.
	const markRead = useMutation({
		mutationFn: (id: string) => client.readings.markRead({ id }),
		onSuccess: () =>
			Promise.all([queryClient.invalidateQueries({ queryKey: orpc.readings.key() }), queryClient.invalidateQueries({ queryKey: orpc.books.key() })]),
	})
	// The same query SectionView makes: a web book's section opens the page it came from.
	const sectionId = reading.data?.status === 'ready' ? reading.data.contents[current]?.id : undefined
	const shown = useQuery({ ...orpc.readings.section.queryOptions({ input: { id: sectionId ?? '' } }), enabled: Boolean(sectionId) })

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
		setContentsOpen(false)
		window.scrollTo({ top: 0 })
	}
	const contents = <Contents reading={r} current={current} onPick={pick} />
	const step = 'rounded-xl border border-world-line px-4 py-2 font-sans text-sm transition hover:bg-world-card active:scale-[0.97]'

	return (
		<div className="grid gap-8 md:grid-cols-[14rem_minmax(0,1fr)]">
			<aside className="hidden md:block">
				<nav aria-label="Contents" className="sticky top-20 max-h-[calc(100dvh-6rem)] overflow-y-auto">
					{contents}
				</nav>
			</aside>
			<div className="mx-auto grid w-full max-w-[65ch] gap-6">
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
					<h1 className="text-3xl font-semibold tracking-tight md:text-4xl">{r.title}</h1>
					<p className="font-sans text-sm text-world-muted">
						{r.author && `${r.author}${original ? ' · ' : ''}`}
						{original && (
							<a href={original} target="_blank" rel="noopener noreferrer nofollow" className="underline underline-offset-2">
								Open original
							</a>
						)}
					</p>
				</header>
				<div className="md:hidden">
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
						id={section.id}
						readingId={r.id}
						onEnd={current === r.contents.length - 1 && !r.readAt && !markRead.isPending ? () => markRead.mutate(r.id) : undefined}
					/>
				)}
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
