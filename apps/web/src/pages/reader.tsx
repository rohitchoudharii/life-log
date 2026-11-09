import type { ReadingWithContents } from '@life-log-club/contract'
import type { Block, Link as TextLink } from '@life-log-club/domain'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { type ReactNode, useEffect, useState } from 'react'
import { errorMessage, orpc } from '../rpc'

/** Text with its link ranges as links that open the original page in a new tab. */
function withLinks(text: string, links: TextLink[] = []): ReactNode {
	if (!links.length) return text
	const out: ReactNode[] = []
	let at = 0
	for (const link of links) {
		if (link.start < at) continue
		out.push(text.slice(at, link.start))
		out.push(
			<a key={link.start} href={link.href} target="_blank" rel="noopener noreferrer nofollow" className="text-world-accent underline underline-offset-2">
				{text.slice(link.start, link.end)}
			</a>,
		)
		at = link.end
	}
	out.push(text.slice(at))
	return out
}

/** Renders our own blocks as plain elements; nothing from the original page's HTML is used. */
function BlockView({ block }: { block: Block }) {
	switch (block.type) {
		case 'heading':
			return <h3 className="mt-6 text-xl font-semibold">{block.text}</h3>
		case 'paragraph':
			return <p>{withLinks(block.text, block.links)}</p>
		case 'quote':
			return <blockquote className="border-l-2 border-world-line pl-4 italic">{withLinks(block.text, block.links)}</blockquote>
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
						<li key={i}>{withLinks(item, block.links?.filter((l) => l.item === i))}</li>
					))}
				</List>
			)
		}
		case 'image':
			// Images are not stored yet; the reader keeps their description in place.
			return block.alt ? <p className="font-sans text-sm text-world-muted italic">Image: {block.alt}</p> : null
	}
}

function SectionView({ id }: { id: string }) {
	const section = useQuery(orpc.readings.section.queryOptions({ input: { id } }))
	if (section.isError) return <p role="alert">{errorMessage(section.error)}</p>
	if (!section.data) return <p className="text-world-muted">Loading…</p>
	return (
		<article className="grid gap-4 text-lg leading-relaxed">
			<h2 className="text-2xl font-semibold tracking-tight">{section.data.title}</h2>
			{section.data.blocks.map((b, i) => (
				<BlockView key={i} block={b} />
			))}
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
						{s.title}
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
				<h1 className="text-2xl">{r.requestedUrl}</h1>
				{r.status === 'importing' ? <p className="animate-pulse text-world-muted">Importing…</p> : <p role="alert">{r.error}</p>}
			</div>
		)

	const section = r.contents[current]
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
					<Link to="/mind" className="font-sans text-sm text-world-muted">
						← Reading room
					</Link>
					<h1 className="text-3xl font-semibold tracking-tight md:text-4xl">{r.title}</h1>
					<p className="font-sans text-sm text-world-muted">
						{r.author && `${r.author} · `}
						{r.sourceUrl && (
							<a href={r.sourceUrl} target="_blank" rel="noopener noreferrer nofollow" className="underline underline-offset-2">
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
				{section && <SectionView id={section.id} />}
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
