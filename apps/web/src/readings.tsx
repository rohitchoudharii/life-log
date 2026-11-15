import { type Book, FILE_TOO_LARGE, MAX_FILE_BYTES, type Reading } from '@life-log-club/contract'
import { goalPace } from '@life-log-club/domain'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { type DragEvent, useRef, useState } from 'react'
import { AddToBook, chaptersRead, quiet, useBooks, useRemoveBook } from './books'
import { when } from './entries'
import { client, errorMessage, orpc } from './rpc'
import { useToast } from './toast'

const listKey = orpc.readings.list.queryKey()

/** What an importing reading shows; a web book counts its pages as they arrive. */
export const importingText = ({ progress }: Pick<Reading, 'progress'>) =>
	!progress ? 'Importing…' : progress.scan ? `Reading scanned pages… ${progress.done} of ${progress.total}` : `Importing… ${progress.done} of ${progress.total} pages`

/** The member's readings, asked for again every 1.5 seconds while one is importing. */
export const useReadings = () =>
	useQuery({
		...orpc.readings.list.queryOptions(),
		refetchInterval: (query) => (query.state.data?.some((r) => r.status === 'importing') ? 1500 : false),
	})

/**
 * Adds a link. It shows in Reading now at once as importing, with the id the client picked, so
 * a retry can't make a second one. A link the member already has opens that reading instead.
 */
function useAddReading() {
	const queryClient = useQueryClient()
	const navigate = useNavigate()
	const toast = useToast()
	const mutation = useMutation({
		mutationFn: (link: { id: string; url: string }) => client.readings.add(link),
		onMutate: async ({ id, url }) => {
			await queryClient.cancelQueries({ queryKey: listKey })
			const placeholder: Reading = {
				id,
				title: url,
				author: null,
				sourceUrl: null,
				requestedUrl: url,
				status: 'importing',
				error: null,
				wordCount: 0,
				sectionCount: 0,
				progress: null,
				partOfBook: null,
				source: 'url',
				readAt: null,
				position: null,
				lastOpenedAt: null,
				book: null,
				wordsRead: 0,
				goalBy: null,
				finishedAt: null,
				createdAt: new Date(),
			}
			const before = queryClient.getQueryData<Reading[]>(listKey)
			queryClient.setQueryData<Reading[]>(listKey, (list) => [placeholder, ...(list ?? []).filter((r) => r.requestedUrl !== url)])
			return { before }
		},
		onError: (error, _link, context) => {
			queryClient.setQueryData(listKey, context?.before)
			toast({ text: errorMessage(error) })
		},
		onSuccess: (reading, link) => {
			if (reading.id !== link.id && reading.status === 'ready') {
				toast({ text: 'You already have this reading.' })
				void navigate({ to: '/mind/read/$readingId', params: { readingId: reading.id } })
			}
		},
		onSettled: () => queryClient.invalidateQueries({ queryKey: listKey }),
	})
	return (url: string) => mutation.mutate({ id: crypto.randomUUID(), url })
}

/**
 * Adds an EPUB or PDF file. It shows in Reading now at once as importing, titled with the file
 * name, while the server reads it.
 */
export function useAddFile() {
	const queryClient = useQueryClient()
	const toast = useToast()
	const mutation = useMutation({
		mutationFn: (upload: { id: string; file: File }) => client.readings.addFile(upload),
		onMutate: async ({ id, file }) => {
			await queryClient.cancelQueries({ queryKey: listKey })
			const before = queryClient.getQueryData<Reading[]>(listKey)
			const placeholder: Reading = {
				id,
				title: file.name.replace(/\.(epub|pdf)$/i, ''),
				author: null,
				sourceUrl: null,
				requestedUrl: null,
				status: 'importing',
				error: null,
				wordCount: 0,
				sectionCount: 0,
				progress: null,
				partOfBook: null,
				source: /\.pdf$/i.test(file.name) ? 'pdf_upload' : 'epub',
				readAt: null,
				position: null,
				lastOpenedAt: null,
				book: null,
				wordsRead: 0,
				goalBy: null,
				finishedAt: null,
				createdAt: new Date(),
			}
			queryClient.setQueryData<Reading[]>(listKey, (list) => [placeholder, ...(list ?? [])])
			return { before }
		},
		onError: (error, _upload, context) => {
			queryClient.setQueryData(listKey, context?.before)
			toast({ text: errorMessage(error) })
		},
		onSuccess: (reading, upload) => {
			if (reading.id !== upload.id) toast({ text: 'You already have this book.' })
		},
		onSettled: () => queryClient.invalidateQueries({ queryKey: listKey }),
	})
	return (file: File) => {
		// Checked here too, so a large file isn't uploaded only to be refused.
		if (file.size > MAX_FILE_BYTES) return toast({ text: FILE_TOO_LARGE })
		mutation.mutate({ id: crypto.randomUUID(), file })
	}
}

/** Lets a member drop an EPUB or PDF anywhere on the element that spreads these handlers. */
export function useFileDrop() {
	const addFile = useAddFile()
	const [dragging, setDragging] = useState(false)
	const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes('Files')
	return {
		dragging,
		handlers: {
			onDragOver: (e: DragEvent) => {
				if (!hasFiles(e)) return
				e.preventDefault()
				setDragging(true)
			},
			onDragLeave: (e: DragEvent) => {
				if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
			},
			onDrop: (e: DragEvent) => {
				if (!hasFiles(e)) return
				e.preventDefault()
				setDragging(false)
				for (const file of e.dataTransfer.files) addFile(file)
			},
		},
	}
}

/**
 * Adds pasted text. It is ready at once, so the reader opens on it straight away. The client
 * picks the id, so a retry can't make a second one.
 */
function useAddText(done: () => void) {
	const queryClient = useQueryClient()
	const navigate = useNavigate()
	const toast = useToast()
	return useMutation({
		mutationFn: (text: string) => client.readings.addText({ id: crypto.randomUUID(), text }),
		onError: (error) => toast({ text: errorMessage(error) }),
		onSuccess: (reading) => {
			done()
			void navigate({ to: '/mind/read/$readingId', params: { readingId: reading.id } })
		},
		onSettled: () => queryClient.invalidateQueries({ queryKey: listKey }),
	})
}

/** Anything with a space or a line break in it is text to read, not a link. */
const isText = (pasted: string) => /\s/.test(pasted.trim())

const box = 'min-w-0 flex-1 basis-full rounded-xl bg-transparent px-3 py-2 font-sans text-base outline-none placeholder:text-world-muted md:basis-0'
const primary =
	'rounded-xl bg-world-accent px-5 py-2 font-sans text-sm font-semibold text-world-on-accent transition hover:opacity-90 active:scale-[0.97] disabled:opacity-60'
const secondary = 'rounded-xl border border-world-line px-4 py-2 font-sans text-sm font-medium whitespace-nowrap transition hover:bg-world active:scale-[0.97]'

/**
 * One box to paste a link into, and Add; a button to add an EPUB or PDF file; and Paste text,
 * which turns the box into a text area. Text pasted into the link box turns it too.
 */
export function AddReading() {
	const [url, setUrl] = useState('')
	const [text, setText] = useState<string | null>(null)
	const add = useAddReading()
	const addFile = useAddFile()
	const addText = useAddText(() => setText(null))
	const picker = useRef<HTMLInputElement>(null)
	const area = useRef<HTMLTextAreaElement>(null)
	const toText = (value: string) => {
		setText(value)
		requestAnimationFrame(() => area.current?.focus())
	}

	if (text !== null)
		return (
			<form
				className="grid gap-2 rounded-2xl border border-world-line bg-world-card p-2"
				onSubmit={(e) => {
					e.preventDefault()
					if (text.trim()) addText.mutate(text)
				}}
			>
				<label className="sr-only" htmlFor="add-text">
					Text to read
				</label>
				<textarea
					id="add-text"
					ref={area}
					required
					rows={8}
					placeholder="Paste text or Markdown. The first heading, or the first words, becomes the title."
					value={text}
					onChange={(e) => setText(e.target.value)}
					className={`${box} min-h-40 resize-y`}
				/>
				<div className="flex flex-wrap gap-2">
					<button type="submit" disabled={addText.isPending} className={primary}>
						{addText.isPending ? 'Adding…' : 'Add'}
					</button>
					<button type="button" onClick={() => setText(null)} className={secondary}>
						Paste a link instead
					</button>
				</div>
			</form>
		)

	return (
		<form
			className="flex flex-wrap gap-2 rounded-2xl border border-world-line bg-world-card p-2 md:flex-nowrap"
			onSubmit={(e) => {
				e.preventDefault()
				if (!url.trim()) return
				add(url.trim())
				setUrl('')
			}}
		>
			<label className="sr-only" htmlFor="add-reading">
				Add a reading
			</label>
			<input
				id="add-reading"
				type="text"
				inputMode="url"
				autoComplete="off"
				placeholder="Paste a link or text, or drop an EPUB or PDF"
				value={url}
				onChange={(e) => setUrl(e.target.value)}
				onPaste={(e) => {
					const pasted = e.clipboardData.getData('text')
					if (!url && isText(pasted)) {
						e.preventDefault()
						toText(pasted)
					}
				}}
				className={box}
			/>
			<button type="submit" className={primary}>
				Add
			</button>
			<button type="button" onClick={() => toText('')} className={secondary}>
				Paste text
			</button>
			<button type="button" onClick={() => picker.current?.click()} className={secondary}>
				Add a file
			</button>
			<input
				ref={picker}
				type="file"
				accept=".epub,.pdf,application/epub+zip,application/pdf"
				aria-label="EPUB or PDF file"
				hidden
				onChange={(e) => {
					for (const file of e.target.files ?? []) addFile(file)
					e.target.value = ''
				}}
			/>
		</form>
	)
}

const minutes = (words: number) => `${Math.max(1, Math.round(words / 230))} min`
// The importing placeholder holds the text as pasted, which may not parse as an address.
const host = (url: string | null) => (url && URL.parse(url)?.hostname.replace(/^www\./, '')) || ''

function useRemoveReading() {
	const queryClient = useQueryClient()
	const toast = useToast()
	const refresh = () => queryClient.invalidateQueries({ queryKey: listKey })
	return useMutation({
		mutationFn: (reading: Reading) => client.readings.remove({ id: reading.id }).then(() => reading),
		onSuccess: async (reading) => {
			await refresh()
			toast({ text: `Removed: ${reading.title}`, undo: () => void client.readings.restore({ id: reading.id }).then(refresh) })
		},
		onError: (error) => toast({ text: errorMessage(error) }),
	})
}

/**
 * Adds the whole web book a chapter reading is part of. The chapter's card turns into the book's,
 * importing; a book the member already has takes the chapter's place.
 */
function useAddBook() {
	const queryClient = useQueryClient()
	const toast = useToast()
	return useMutation({
		mutationFn: (chapter: Reading) => client.readings.addBook({ id: chapter.id, bookId: crypto.randomUUID() }),
		onSuccess: (book) => {
			if (book.status === 'ready') toast({ text: 'You already have this book.' })
		},
		onError: (error) => toast({ text: errorMessage(error) }),
		onSettled: () => queryClient.invalidateQueries({ queryKey: listKey }),
	})
}

const shortDay = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
const todayUtc = () => new Date().toISOString().slice(0, 10)

/** The goal line under a reading's title ("about 12 pages a day to finish by 1 Mar"), or nothing without a goal. */
function GoalLine({ reading }: { reading: Reading }) {
	if (!reading.goalBy) return null
	const pace = goalPace({ wordCount: reading.wordCount, wordsRead: reading.wordsRead, goalBy: reading.goalBy, today: todayUtc() })
	return (
		<p className="truncate font-sans text-xs text-world-accent" data-testid="goal">
			{pace.passed ? 'Goal date passed' : `About ${pace.pagesPerDay} ${pace.pagesPerDay === 1 ? 'page' : 'pages'} a day to finish by ${shortDay(reading.goalBy)}`}
		</p>
	)
}

/** Finish by, which sets the goal day or clears it. */
function GoalButton({ reading }: { reading: Reading }) {
	const queryClient = useQueryClient()
	const [editing, setEditing] = useState(false)
	const save = useMutation({
		mutationFn: (goalBy: string | null) => client.readings.update({ id: reading.id, goalBy }),
		onSuccess: async () => {
			setEditing(false)
			await queryClient.invalidateQueries({ queryKey: listKey })
		},
	})
	if (!editing)
		return (
			<button type="button" className={quiet} onClick={() => setEditing(true)}>
				{reading.goalBy ? 'Change goal' : 'Finish by'}
			</button>
		)
	return (
		<label className="flex items-center gap-2">
			<span>Finish by</span>
			<input
				type="date"
				// biome-ignore lint/a11y/noAutofocus: the member just asked for this box.
				autoFocus
				min={todayUtc()}
				defaultValue={reading.goalBy ?? ''}
				onChange={(e) => e.target.value && save.mutate(e.target.value)}
				className="rounded-lg border border-world-line bg-world px-2 py-1"
			/>
			{reading.goalBy && (
				<button type="button" className="text-world-muted underline underline-offset-2" onClick={() => save.mutate(null)}>
					No goal
				</button>
			)}
		</label>
	)
}

/** Readings finished, this year's first, each opening at its milestone. Earlier years are listed after them. */
export function FinishedReadings() {
	const readings = useReadings()
	const done = (readings.data ?? []).filter((r) => r.finishedAt).sort((a, b) => b.finishedAt!.getTime() - a.finishedAt!.getTime())
	if (!done.length) return null
	const year = new Date().getFullYear()
	const groups = [
		{ title: 'Finished this year', list: done.filter((r) => r.finishedAt!.getFullYear() === year) },
		{ title: 'Finished before', list: done.filter((r) => r.finishedAt!.getFullYear() !== year) },
	].filter((g) => g.list.length)
	return (
		<>
			{groups.map((g) => (
				<section key={g.title} className="grid gap-3" aria-label={g.title}>
					<h2 className="text-xl">{g.title}</h2>
					<ul className="flex flex-wrap gap-2">
						{g.list.map((r) => (
							<li key={r.id}>
								<Link
									to="/mind/read/$readingId"
									params={{ readingId: r.id }}
									className="inline-block rounded-xl border border-world-line bg-world-card px-3 py-2 italic transition hover:border-world-accent"
								>
									{r.title}
								</Link>
							</li>
						))}
					</ul>
				</section>
			))}
		</>
	)
}

/** When the member last had it open, or when they added it if they never have. */
function LastRead({ item }: { item: { lastOpenedAt: Date | null; createdAt: Date } }) {
	// The day is enough for when it was added; the time is for when it was last read.
	const text = item.lastOpenedAt ? when(item.lastOpenedAt) : `Added ${when(item.createdAt).replace(/^(Today|Yesterday) .*/, (_, day: string) => day.toLowerCase())}`
	return <span className={`font-sans text-xs whitespace-nowrap tabular-nums ${item.lastOpenedAt ? '' : 'text-world-muted'}`}>{text}</span>
}

/** A thin bar and the share read, or Not started. */
function Progress({ percent, started, small }: { percent: number; started: boolean; small?: boolean }) {
	return (
		<span className={small ? 'flex items-center gap-2' : 'grid gap-1'}>
			<span aria-hidden className={`block h-1 overflow-hidden rounded-full bg-world-line ${small ? 'w-12' : ''}`}>
				<span className="block h-full bg-world-accent" style={{ width: `${percent}%` }} />
			</span>
			<span className="font-sans text-xs text-world-muted tabular-nums">{started || percent ? `${percent}%` : 'Not started'}</span>
		</span>
	)
}

const percentOf = (done: number, total: number) => (total ? Math.round((done / total) * 100) : 0)

// One column on a phone with Continue and More beside it; progress and last read get their own columns from md up.
const rowGrid = 'relative grid grid-cols-[minmax(0,1fr)_auto_2rem] items-center gap-x-3 px-4 py-2.5 md:grid-cols-[minmax(0,1fr)_7rem_8rem_6rem_2rem]'
// The title link covers the whole row, so the row opens in one click; the buttons sit above it.
const stretched = 'block truncate text-lg leading-snug after:absolute after:inset-0 hover:underline'
const above = 'relative z-10'

/** Remove, and a second step that asks first. Cancel or Esc keeps it. */
function RemoveButton({ question, pending, onRemove }: { question: string; pending: boolean; onRemove: () => void }) {
	const [asking, setAsking] = useState(false)
	if (!asking)
		return (
			<button type="button" className={`${quiet} ml-auto`} onClick={() => setAsking(true)}>
				Remove
			</button>
		)
	return (
		<div
			role="group"
			aria-label="Confirm remove"
			className="ml-auto flex flex-wrap items-center justify-end gap-2"
			onKeyDown={(e) => {
				if (e.key === 'Escape') {
					e.stopPropagation()
					setAsking(false)
				}
			}}
		>
			<span>{question}</span>
			<button
				type="button"
				// biome-ignore lint/a11y/noAutofocus: the member just asked to remove it, so Esc and Enter answer at once.
				autoFocus
				disabled={pending}
				onClick={onRemove}
				className="rounded-lg bg-red px-3 py-1.5 font-semibold text-white transition hover:opacity-90 active:scale-[0.97] disabled:opacity-60"
			>
				Yes, remove
			</button>
			<button type="button" className={quiet} onClick={() => setAsking(false)}>
				Cancel
			</button>
		</div>
	)
}

function MoreButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
	return (
		<button
			type="button"
			aria-label="More"
			aria-expanded={open}
			onClick={onToggle}
			className={`${above} grid size-8 place-items-center rounded-lg font-sans text-world-muted transition hover:bg-world hover:text-world-ink`}
		>
			⋯
		</button>
	)
}

const panel = 'flex flex-wrap items-center gap-2 border-t border-dashed border-world-line px-4 py-2.5 font-sans text-sm'

function ContinueLink({ readingId, primary }: { readingId: string; primary: boolean }) {
	return (
		<Link
			to="/mind/read/$readingId"
			params={{ readingId }}
			className={`${above} justify-self-end ${primary ? 'rounded-lg bg-world-accent px-3 py-1.5 font-sans text-sm font-semibold text-world-on-accent transition hover:opacity-90' : quiet}`}
		>
			Continue
		</Link>
	)
}

/** A book in Reading now: chapters read, last read, Continue at the first chapter not read yet, and Remove under More. */
function BookItem({ book, primary }: { book: Book; primary: boolean }) {
	const [more, setMore] = useState(false)
	const remove = useRemoveBook()
	return (
		<li data-testid="book" className="transition hover:bg-world/40">
			<div className={rowGrid}>
				<div className="min-w-0">
					<Link to="/mind/book/$bookId" params={{ bookId: book.id }} className={stretched}>
						{book.title}
					</Link>
					<p className="truncate font-sans text-xs text-world-muted">Book · {chaptersRead(book)}</p>
					<p className="mt-1 flex items-center gap-2 md:hidden">
						<Progress small percent={percentOf(book.readCount, book.chapterCount)} started={book.readCount > 0} />
						<LastRead item={book} />
					</p>
				</div>
				<span className="hidden md:block">
					<Progress percent={percentOf(book.readCount, book.chapterCount)} started={book.readCount > 0} />
				</span>
				<span className="hidden md:block">
					<LastRead item={book} />
				</span>
				{book.continueId ? <ContinueLink readingId={book.continueId} primary={primary} /> : <span />}
				<MoreButton open={more} onToggle={() => setMore(!more)} />
			</div>
			{more && (
				<div className={panel}>
					<RemoveButton question="Remove this book? Its chapters become articles again." pending={remove.isPending} onRemove={() => remove.mutate(book)} />
				</div>
			)}
		</li>
	)
}

function ReadingItem({ reading, primary }: { reading: Reading; primary: boolean }) {
	const add = useAddReading()
	const remove = useRemoveReading()
	const addBook = useAddBook()
	const [more, setMore] = useState(false)
	if (reading.status === 'ready') {
		const percent = percentOf(reading.wordsRead, reading.wordCount)
		return (
			<li data-testid="reading" className="transition hover:bg-world/40">
				<div className={rowGrid}>
					<div className="min-w-0">
						<Link to="/mind/read/$readingId" params={{ readingId: reading.id }} className={stretched}>
							{reading.title}
						</Link>
						<p className="truncate font-sans text-xs text-world-muted">
							{[reading.author, host(reading.sourceUrl), `${reading.sectionCount} ${reading.sectionCount === 1 ? 'section' : 'sections'}`, minutes(reading.wordCount)]
								.filter(Boolean)
								.join(' · ')}
						</p>
						<GoalLine reading={reading} />
						{reading.partOfBook && (
							<p className="truncate font-sans text-xs text-world-muted">
								Part of <i>{reading.partOfBook.title}</i> · {reading.partOfBook.pages} pages
							</p>
						)}
						<p className="mt-1 flex items-center gap-2 md:hidden">
							<Progress small percent={percent} started={!!reading.position} />
							<LastRead item={reading} />
						</p>
					</div>
					<span className="hidden md:block">
						<Progress percent={percent} started={!!reading.position} />
					</span>
					<span className="hidden md:block">
						<LastRead item={reading} />
					</span>
					{reading.position && !reading.readAt ? <ContinueLink readingId={reading.id} primary={primary} /> : <span />}
					<MoreButton open={more} onToggle={() => setMore(!more)} />
				</div>
				{more && (
					<div className={panel}>
						<GoalButton reading={reading} />
						{reading.partOfBook && (
							<button type="button" className={quiet} disabled={addBook.isPending} onClick={() => addBook.mutate(reading)}>
								{addBook.isPending ? 'Adding…' : 'Add the whole book'}
							</button>
						)}
						{/* Only an article from a link can be a chapter of the member's book. */}
						{(reading.source === 'url' || reading.source === 'web_capture') && <AddToBook reading={reading} />}
						<RemoveButton question="Remove this reading?" pending={remove.isPending} onRemove={() => remove.mutate(reading)} />
					</div>
				)}
			</li>
		)
	}
	return (
		<li data-testid="reading">
			<div className={rowGrid}>
				<div className="min-w-0">
					<p className="truncate text-lg leading-snug text-world-muted">
						{reading.status !== 'importing' ? (reading.requestedUrl ?? reading.title) : reading.progress ? reading.title : host(reading.requestedUrl) || reading.title}
					</p>
					{reading.status === 'importing' ? (
						<p className="animate-pulse truncate font-sans text-xs text-world-muted">{importingText(reading)}</p>
					) : (
						<p role="alert" className="font-sans text-xs text-red">
							{reading.error}
						</p>
					)}
				</div>
				<span className="hidden md:block" />
				<span className="hidden md:block">
					<LastRead item={reading} />
				</span>
				{reading.status === 'failed' ? (
					<div className="col-span-2 flex justify-end gap-2">
						{/* A file is tried again by adding it again; only a link can be fetched again from here. */}
						{reading.requestedUrl && (
							<button type="button" className={quiet} onClick={() => add(reading.requestedUrl!)}>
								Try again
							</button>
						)}
						<button type="button" className={quiet} onClick={() => remove.mutate(reading)}>
							Remove
						</button>
					</div>
				) : (
					<span className="col-span-2" />
				)}
			</div>
		</li>
	)
}

const lastSeen = (item: { lastOpenedAt: Date | null; createdAt: Date }) => (item.lastOpenedAt ?? item.createdAt).getTime()

/**
 * What the member is reading, books and readings together, the one they had open last first. One
 * never opened counts from when it was added, so a new import shows at the top.
 */
export function ReadingNow() {
	const readings = useReadings()
	const books = useBooks()
	if (!readings.data || !books.data) return null
	// Finished readings move to Finished this year.
	const reading = readings.data.filter((r) => !r.finishedAt)
	if (!reading.length && !books.data.length)
		return <p className="text-world-muted">Nothing to read yet. Paste a link above, or add an EPUB or PDF.</p>
	const items = [...books.data.map((book) => ({ id: book.id, at: lastSeen(book), book })), ...reading.map((r) => ({ id: r.id, at: lastSeen(r), reading: r }))].sort(
		(a, b) => b.at - a.at,
	)
	// The latest thing to go back to gets the strong Continue.
	const next = items.find((i) => ('book' in i ? i.book.continueId : i.reading.position && !i.reading.readAt && i.reading.status === 'ready'))?.id
	return (
		<ul aria-label="Reading now" className="divide-y divide-world-line rounded-2xl border border-world-line bg-world-card">
			{items.map((i) =>
				'book' in i ? <BookItem key={i.id} book={i.book} primary={i.id === next} /> : <ReadingItem key={i.id} reading={i.reading} primary={i.id === next} />,
			)}
		</ul>
	)
}
