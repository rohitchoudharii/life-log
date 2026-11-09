import { FILE_TOO_LARGE, MAX_FILE_BYTES, type Reading } from '@life-log-club/contract'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { type DragEvent, useRef, useState } from 'react'
import { AddToBook, BookItem, useBooks } from './books'
import { client, errorMessage, orpc } from './rpc'
import { useToast } from './toast'

const listKey = orpc.readings.list.queryKey()

/** What an importing reading shows; a web book counts its pages as they arrive. */
export const importingText = ({ progress }: Pick<Reading, 'progress'>) =>
	progress ? `Importing… ${progress.done} of ${progress.total} pages` : 'Importing…'

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
				book: null,
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
				book: null,
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

/** One box to paste a link into, and Add; and a button to add an EPUB or PDF file. */
export function AddReading() {
	const [url, setUrl] = useState('')
	const add = useAddReading()
	const addFile = useAddFile()
	const picker = useRef<HTMLInputElement>(null)
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
				placeholder="Paste a link, or drop an EPUB or PDF"
				value={url}
				onChange={(e) => setUrl(e.target.value)}
				className="min-w-0 flex-1 basis-full rounded-xl bg-transparent px-3 py-2 font-sans text-base outline-none placeholder:text-world-muted md:basis-0"
			/>
			<button
				type="submit"
				className="rounded-xl bg-world-accent px-5 py-2 font-sans text-sm font-semibold text-world-on-accent transition hover:opacity-90 active:scale-[0.97]"
			>
				Add
			</button>
			<button
				type="button"
				onClick={() => picker.current?.click()}
				className="rounded-xl border border-world-line px-4 py-2 font-sans text-sm font-medium whitespace-nowrap transition hover:bg-world active:scale-[0.97]"
			>
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

function ReadingItem({ reading }: { reading: Reading }) {
	const add = useAddReading()
	const remove = useRemoveReading()
	const addBook = useAddBook()
	const quiet = 'rounded-lg border border-world-line px-3 py-1.5 font-sans text-sm transition hover:bg-world active:scale-[0.97]'
	if (reading.status === 'ready')
		return (
			<li data-testid="reading" className="rounded-2xl border border-world-line bg-world-card transition hover:border-world-accent">
				<Link to="/mind/read/$readingId" params={{ readingId: reading.id }} className="block p-4">
					<p className="text-lg leading-snug">{reading.title}</p>
					<p className="mt-1 font-sans text-sm text-world-muted">
						{[reading.author, host(reading.sourceUrl), `${reading.sectionCount} ${reading.sectionCount === 1 ? 'section' : 'sections'}`, minutes(reading.wordCount)]
							.filter(Boolean)
							.join(' · ')}
					</p>
				</Link>
				{reading.partOfBook && (
					<div className="flex flex-wrap items-center justify-between gap-2 border-t border-world-line px-4 py-3 font-sans text-sm">
						<p className="text-world-muted">
							Part of <i>{reading.partOfBook.title}</i> · {reading.partOfBook.pages} pages
						</p>
						<button type="button" className={quiet} disabled={addBook.isPending} onClick={() => addBook.mutate(reading)}>
							{addBook.isPending ? 'Adding…' : 'Add the whole book'}
						</button>
					</div>
				)}
				{/* Only an article from a link can be a chapter of the member's book. */}
				{reading.source === 'url' && (
					<div className="flex flex-wrap items-center gap-2 border-t border-world-line px-4 py-3">
						<AddToBook reading={reading} />
					</div>
				)}
			</li>
		)
	return (
		<li data-testid="reading" className="rounded-2xl border border-dashed border-world-line p-4">
			<p className="truncate text-lg leading-snug">
				{reading.status !== 'importing' ? (reading.requestedUrl ?? reading.title) : reading.progress ? reading.title : host(reading.requestedUrl) || reading.title}
			</p>
			{reading.status === 'importing' ? (
				<p className="mt-1 animate-pulse font-sans text-sm text-world-muted">{importingText(reading)}</p>
			) : (
				<>
					<p role="alert" className="mt-1 font-sans text-sm text-red">
						{reading.error}
					</p>
					<div className="mt-3 flex gap-2">
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
				</>
			)}
		</li>
	)
}

/** What the member is reading, newest first, with imports still running and the ones that failed. */
export function ReadingNow() {
	const readings = useReadings()
	const books = useBooks()
	if (!readings.data || !books.data) return null
	if (!readings.data.length && !books.data.length)
		return <p className="text-world-muted">Nothing to read yet. Paste a link above, or add an EPUB or PDF.</p>
	return (
		<ul className="grid items-start gap-3 md:grid-cols-2">
			{books.data.map((b) => (
				<BookItem key={b.id} book={b} />
			))}
			{readings.data.map((r) => (
				<ReadingItem key={r.id} reading={r} />
			))}
		</ul>
	)
}
