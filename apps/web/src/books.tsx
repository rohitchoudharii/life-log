import type { Book, BookWithChapters, Reading } from '@life-log-club/contract'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { client, errorMessage, orpc } from './rpc'
import { useToast } from './toast'

export const quiet = 'rounded-lg border border-world-line px-3 py-1.5 font-sans text-sm transition hover:bg-world active:scale-[0.97] disabled:opacity-60'

export const useBooks = () => useQuery(orpc.books.list.queryOptions())

/** A change to a book changes the books, the readings Mind shows on their own, and the open book. */
function useRefreshLibrary() {
	const queryClient = useQueryClient()
	return () => Promise.all([queryClient.invalidateQueries({ queryKey: orpc.books.key() }), queryClient.invalidateQueries({ queryKey: orpc.readings.key() })])
}

export const chaptersRead = (book: Pick<Book, 'chapterCount' | 'readCount'>) =>
	book.chapterCount ? `${book.readCount} of ${book.chapterCount} ${book.chapterCount === 1 ? 'chapter' : 'chapters'} read` : 'No chapters yet'

/** A title box and Save, for a new book. Esc or Cancel closes it. */
function NewBookForm({ onCreated, onClose }: { onCreated: (book: Book) => void; onClose: () => void }) {
	const [title, setTitle] = useState('')
	const refresh = useRefreshLibrary()
	const toast = useToast()
	const create = useMutation({
		mutationFn: (t: string) => client.books.create({ id: crypto.randomUUID(), title: t }),
		onSuccess: async (book) => {
			await refresh()
			onCreated(book)
		},
		onError: (error) => toast({ text: errorMessage(error) }),
	})
	return (
		<form
			className="flex flex-wrap items-center gap-2"
			onSubmit={(e) => {
				e.preventDefault()
				if (title.trim()) create.mutate(title.trim())
			}}
			onKeyDown={(e) => {
				if (e.key === 'Escape') {
					e.stopPropagation()
					onClose()
				}
			}}
		>
			<label className="sr-only" htmlFor="new-book-title">
				Book title
			</label>
			<input
				id="new-book-title"
				// biome-ignore lint/a11y/noAutofocus: the member just asked for this box.
				autoFocus
				value={title}
				onChange={(e) => setTitle(e.target.value)}
				placeholder="Book title"
				className="min-w-0 flex-1 rounded-lg border border-world-line bg-world px-3 py-1.5 font-sans text-sm outline-none focus:border-world-accent"
			/>
			<button type="submit" className={quiet} disabled={create.isPending}>
				Save
			</button>
			<button type="button" className={quiet} onClick={onClose}>
				Cancel
			</button>
		</form>
	)
}

/** New book, beside the Reading now heading. */
export function NewBook() {
	const [open, setOpen] = useState(false)
	const toast = useToast()
	if (!open)
		return (
			<button type="button" className={quiet} onClick={() => setOpen(true)}>
				New book
			</button>
		)
	return (
		<NewBookForm
			onClose={() => setOpen(false)}
			onCreated={(book) => {
				setOpen(false)
				toast({ text: `Made ${book.title}. Use Add to book on an article to fill it.` })
			}}
		/>
	)
}

/**
 * Add to book on an article's card: a short list of the member's books, newest first, and New
 * book… to make one and add the article to it at once. An article in a book moves to the one picked.
 */
export function AddToBook({ reading }: { reading: Reading }) {
	const [open, setOpen] = useState(false)
	const [making, setMaking] = useState(false)
	const books = useBooks()
	const refresh = useRefreshLibrary()
	const toast = useToast()
	const add = useMutation({
		mutationFn: (book: Pick<Book, 'id' | 'title'>) => client.books.addChapter({ bookId: book.id, readingId: reading.id }),
		onSuccess: async (book) => {
			setOpen(false)
			await refresh()
			toast({ text: `Added to ${book.title}` })
		},
		onError: (error) => toast({ text: errorMessage(error) }),
	})
	if (!open)
		return (
			<button type="button" className={quiet} aria-expanded="false" onClick={() => setOpen(true)}>
				Add to book
			</button>
		)
	return (
		<div
			role="group"
			aria-label={`Add ${reading.title} to a book`}
			className="grid w-full gap-2"
			onKeyDown={(e) => {
				if (e.key === 'Escape') setOpen(false)
			}}
		>
			<p className="font-sans text-xs text-world-muted">Add to book</p>
			<div className="flex flex-wrap gap-2">
				{books.data?.map((b) => (
					<button key={b.id} type="button" className={quiet} disabled={add.isPending} onClick={() => add.mutate(b)}>
						{b.title}
					</button>
				))}
				{!making && (
					<button type="button" className={quiet} onClick={() => setMaking(true)}>
						New book…
					</button>
				)}
				<button type="button" className={quiet} onClick={() => setOpen(false)}>
					Cancel
				</button>
			</div>
			{making && <NewBookForm onClose={() => setMaking(false)} onCreated={(book) => add.mutate(book)} />}
		</div>
	)
}

/** A book on Mind: one card with its progress and Continue, opening to its chapters. */
export function BookItem({ book }: { book: Book }) {
	return (
		<li data-testid="book" className="rounded-2xl border border-world-line bg-world-card transition hover:border-world-accent">
			<Link to="/mind/book/$bookId" params={{ bookId: book.id }} className="block p-4">
				<p className="font-sans text-xs font-medium tracking-wide text-world-muted uppercase">Book</p>
				<p className="text-lg leading-snug">{book.title}</p>
				<p className="mt-1 font-sans text-sm text-world-muted">{chaptersRead(book)}</p>
			</Link>
			{book.continueId && (
				<div className="border-t border-world-line px-4 py-3">
					<Link to="/mind/read/$readingId" params={{ readingId: book.continueId }} className={`${quiet} inline-block`}>
						Continue
					</Link>
				</div>
			)}
		</li>
	)
}

function Chapter({
	chapter,
	index,
	count,
	onMove,
	onDropChapter,
	onRemove,
}: {
	chapter: Reading
	index: number
	count: number
	/** Moves this chapter to `to`. */
	onMove: (to: number) => void
	/** Moves the chapter dropped on this one to this one's place. */
	onDropChapter: (id: string) => void
	onRemove: () => void
}) {
	const [over, setOver] = useState(false)
	return (
		<li
			data-testid="chapter"
			draggable
			onDragStart={(e) => {
				e.dataTransfer.setData('text/x-chapter', chapter.id)
				e.dataTransfer.effectAllowed = 'move'
			}}
			onDragOver={(e) => {
				if (!e.dataTransfer.types.includes('text/x-chapter')) return
				e.preventDefault()
				setOver(true)
			}}
			onDragLeave={() => setOver(false)}
			onDrop={(e) => {
				setOver(false)
				const id = e.dataTransfer.getData('text/x-chapter')
				if (id && id !== chapter.id) {
					e.preventDefault()
					onDropChapter(id)
				}
			}}
			className={`flex flex-wrap items-center gap-3 rounded-2xl border bg-world-card p-3 ${over ? 'border-world-accent' : 'border-world-line'}`}
		>
			<span aria-hidden className="w-6 cursor-grab text-center font-sans text-sm text-world-muted">
				{index + 1}
			</span>
			{/* A title needs room: on a phone the arrows and Remove from book wrap to their own line. */}
			<div className="min-w-48 flex-1">
				{chapter.status === 'ready' ? (
					<Link to="/mind/read/$readingId" params={{ readingId: chapter.id }} className="block truncate text-lg leading-snug hover:underline">
						{chapter.title}
					</Link>
				) : (
					<p className="truncate text-lg leading-snug">{chapter.title}</p>
				)}
				<p className="font-sans text-sm text-world-muted">
					{chapter.status === 'importing' ? 'Importing…' : chapter.status === 'failed' ? chapter.error : chapter.readAt ? 'Read' : 'Not read yet'}
				</p>
			</div>
			<div className="ml-auto flex gap-1.5">
				<button type="button" className={quiet} disabled={index === 0} aria-label={`Move up: ${chapter.title}`} onClick={() => onMove(index - 1)}>
					↑
				</button>
				<button
					type="button"
					className={quiet}
					disabled={index === count - 1}
					aria-label={`Move down: ${chapter.title}`}
					onClick={() => onMove(index + 1)}
				>
					↓
				</button>
				<button type="button" className={quiet} onClick={onRemove}>
					Remove from book
				</button>
			</div>
		</li>
	)
}

/** A book: its chapters in order, to read, reorder by dragging or with the arrows, and take out. */
export function BookPage({ bookId }: { bookId: string }) {
	const book = useQuery(orpc.books.get.queryOptions({ input: { id: bookId } }))
	const queryClient = useQueryClient()
	const refresh = useRefreshLibrary()
	const navigate = useNavigate()
	const toast = useToast()
	const [renaming, setRenaming] = useState(false)
	const [title, setTitle] = useState('')
	const key = orpc.books.get.queryKey({ input: { id: bookId } })
	const move = useMutation({
		mutationFn: ({ readingId, to }: { readingId: string; to: number }) => client.books.moveChapter({ readingId, to }),
		// The new order shows at once; the server's answer replaces it.
		onMutate: ({ readingId, to }) => {
			queryClient.setQueryData<BookWithChapters>(key, (b) => {
				if (!b) return b
				const chapters = b.chapters.filter((c) => c.id !== readingId)
				chapters.splice(to, 0, b.chapters.find((c) => c.id === readingId)!)
				return { ...b, chapters }
			})
		},
		onSuccess: (b) => queryClient.setQueryData(key, b),
		onError: (error) => {
			toast({ text: errorMessage(error) })
			void refresh()
		},
	})
	const removeChapter = useMutation({
		mutationFn: (chapter: Reading) => client.books.removeChapter({ readingId: chapter.id }).then(() => chapter),
		onSuccess: async (chapter) => {
			await refresh()
			toast({
				text: `${chapter.title} is an article again`,
				undo: () => void client.books.addChapter({ bookId, readingId: chapter.id }).then(refresh),
			})
		},
		onError: (error) => toast({ text: errorMessage(error) }),
	})
	const rename = useMutation({
		mutationFn: (t: string) => client.books.rename({ id: bookId, title: t }),
		onSuccess: async () => {
			setRenaming(false)
			await refresh()
		},
		onError: (error) => toast({ text: errorMessage(error) }),
	})
	const remove = useMutation({
		mutationFn: () => client.books.remove({ id: bookId }),
		onSuccess: async () => {
			const name = book.data?.title ?? 'the book'
			await refresh()
			void navigate({ to: '/mind' })
			toast({ text: `Removed ${name}. Its chapters are articles again.`, undo: () => void client.books.restore({ id: bookId }).then(refresh) })
		},
		onError: (error) => toast({ text: errorMessage(error) }),
	})

	if (book.isError) return <p role="alert">{errorMessage(book.error)}</p>
	if (!book.data) return null
	const b = book.data
	return (
		<div className="mx-auto grid w-full max-w-3xl gap-6">
			<header className="grid gap-2">
				<Link to="/mind" className="font-sans text-sm text-world-muted">
					← Reading room
				</Link>
				{renaming ? (
					<form
						className="flex flex-wrap gap-2"
						onSubmit={(e) => {
							e.preventDefault()
							if (title.trim()) rename.mutate(title.trim())
						}}
					>
						<label className="sr-only" htmlFor="book-title">
							Book title
						</label>
						<input
							id="book-title"
							value={title}
							onChange={(e) => setTitle(e.target.value)}
							className="min-w-0 flex-1 rounded-lg border border-world-line bg-world px-3 py-2 text-2xl outline-none focus:border-world-accent"
						/>
						<button type="submit" className={quiet}>
							Save
						</button>
						<button type="button" className={quiet} onClick={() => setRenaming(false)}>
							Cancel
						</button>
					</form>
				) : (
					<h1 className="text-3xl font-semibold tracking-tight md:text-4xl">{b.title}</h1>
				)}
				<p className="font-sans text-sm text-world-muted">{chaptersRead(b)}</p>
				<div className="flex flex-wrap gap-2">
					{b.continueId && (
						<Link
							to="/mind/read/$readingId"
							params={{ readingId: b.continueId }}
							className="rounded-xl bg-world-accent px-5 py-2 font-sans text-sm font-semibold text-world-on-accent transition hover:opacity-90"
						>
							Continue
						</Link>
					)}
					{!renaming && (
						<button
							type="button"
							className={quiet}
							onClick={() => {
								setTitle(b.title)
								setRenaming(true)
							}}
						>
							Rename
						</button>
					)}
					<button type="button" className={quiet} onClick={() => remove.mutate()}>
						Remove book
					</button>
				</div>
			</header>
			{b.chapters.length ? (
				<ol aria-label="Chapters" className="grid gap-2">
					{b.chapters.map((c, i) => (
						<Chapter
							key={c.id}
							chapter={c}
							index={i}
							count={b.chapters.length}
							onMove={(to) => move.mutate({ readingId: c.id, to })}
							onDropChapter={(id) => move.mutate({ readingId: id, to: i })}
							onRemove={() => removeChapter.mutate(c)}
						/>
					))}
				</ol>
			) : (
				<p className="text-world-muted">No chapters yet. Use Add to book on an article in the reading room.</p>
			)}
		</div>
	)
}
