import { MAX_CAPTURE_IMAGE_BYTES, MAX_CAPTURE_IMAGES, MAX_CAPTURE_IMAGES_BYTES } from '@life-log-club/contract'
import { type ReactNode, useEffect, useState } from 'react'
import { APP_ORIGIN, client, errorMessage, UNREACHABLE } from '../../lib/api'
import { type ReadPage, readPage } from '../../lib/page'
import { previewWarning } from '../../lib/preview'

type Book = { id: string; title: string }
type Target = Awaited<ReturnType<typeof client.readings.captureTarget>>
type Page = { url: string; title: string; read: ReadPage; books: Book[]; target: Target }
type State =
	| { kind: 'loading' }
	| { kind: 'problem'; text: string; action?: { label: string; run: () => void } }
	| { kind: 'ready'; page: Page }
	| { kind: 'saved'; text: string; readingId: string }

const NO_BOOK = ''
const NEW_BOOK = 'new'
const NOT_A_PAGE = 'Life Log Club can save web pages only.'

const openApp = (path = '/mind') => {
	void browser.tabs.create({ url: `${APP_ORIGIN}${path}` })
	window.close()
}

/** The tab the member clicked the button on. The e2e build is opened as a page, so it names the tab's address. */
async function targetTab() {
	const wanted = new URLSearchParams(location.search).get('url')
	if (import.meta.env.MODE === 'e2e' && wanted) return (await browser.tabs.query({})).find((t) => t.url === wanted)
	return (await browser.tabs.query({ active: true, currentWindow: true }))[0]
}

/** Everything the popup needs before Save: the member, the page as their tab shows it, and the book to offer. */
async function load(): Promise<State> {
	const tab = await targetTab()
	if (!tab?.id || !tab.url || !/^https?:/.test(tab.url)) return { kind: 'problem', text: NOT_A_PAGE }
	if (!(await browser.permissions.contains({ origins: [`${APP_ORIGIN}/*`] })))
		return {
			kind: 'problem',
			text: 'Life Log Club needs access to its own site to save pages.',
			action: { label: 'Allow', run: () => void browser.permissions.request({ origins: [`${APP_ORIGIN}/*`] }).then(() => location.reload()) },
		}
	let me: Awaited<ReturnType<typeof client.auth.me>>
	try {
		me = await client.auth.me()
	} catch {
		return { kind: 'problem', text: UNREACHABLE }
	}
	if (!me.user) return { kind: 'problem', text: 'Sign in to Life Log Club in this browser first.', action: { label: 'Open Life Log Club', run: () => openApp('/') } }
	const limits = { maxImages: MAX_CAPTURE_IMAGES, maxImageBytes: MAX_CAPTURE_IMAGE_BYTES, maxImagesBytes: MAX_CAPTURE_IMAGES_BYTES }
	const reading = browser.scripting
		.executeScript({ target: { tabId: tab.id }, func: readPage, args: [limits] })
		.then(([result]) => (result?.result as ReadPage | undefined) ?? null)
		// Chrome's own pages and the Web Store can't be read.
		.catch(() => null)
	try {
		const [read, books, target] = await Promise.all([reading, client.books.list(), client.readings.captureTarget({ url: tab.url })])
		if (!read) return { kind: 'problem', text: NOT_A_PAGE }
		return { kind: 'ready', page: { url: tab.url, title: tab.title || tab.url, read, books, target } }
	} catch (error) {
		return { kind: 'problem', text: errorMessage(error) }
	}
}

function Frame({ children }: { children: ReactNode }) {
	return (
		<main>
			<header>
				<img src="/icon-32.png" alt="" />
				Life Log Club
			</header>
			{children}
		</main>
	)
}

/** The page, the book to save it in (the last one used on this site), any preview warning, and Save. */
function Ready({ page, onSaved }: { page: Page; onSaved: (saved: { text: string; readingId: string }) => void }) {
	const [bookId, setBookId] = useState(page.target.book?.id ?? NO_BOOK)
	const [newTitle, setNewTitle] = useState('')
	const [ids] = useState(() => ({ reading: crypto.randomUUID(), book: crypto.randomUUID() }))
	const [saving, setSaving] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const books = page.target.book && !page.books.some((b) => b.id === page.target.book!.id) ? [page.target.book, ...page.books] : page.books
	const warning = previewWarning(page.read.signals, page.target)

	const save = async () => {
		setSaving(true)
		setError(null)
		try {
			const book = bookId === NEW_BOOK ? await client.books.create({ id: ids.book, title: newTitle.trim() }) : (books.find((b) => b.id === bookId) ?? null)
			const images = await Promise.all(
				page.read.images.map(async (i) => {
					const blob = await (await fetch(i.dataUrl)).blob()
					return { src: i.src, file: new File([blob], 'image', { type: blob.type }) }
				}),
			)
			const { reading, updated } = await client.readings.capture({ id: ids.reading, url: page.url, html: page.read.html, bookId: book?.id ?? null, images })
			const text = book ? `${updated ? 'Updated in' : 'Saved to'} ${book.title}.` : updated ? 'Updated.' : 'Saved.'
			onSaved({ text, readingId: reading.id })
		} catch (e) {
			setError(errorMessage(e))
			setSaving(false)
		}
	}

	return (
		<Frame>
			<p className="title">{page.title}</p>
			<label>
				Book
				<select value={bookId} onChange={(e) => setBookId(e.target.value)}>
					<option value={NO_BOOK}>No book</option>
					{books.map((b) => (
						<option key={b.id} value={b.id}>
							{b.title}
						</option>
					))}
					<option value={NEW_BOOK}>New book…</option>
				</select>
			</label>
			{bookId === NEW_BOOK && (
				// biome-ignore lint/a11y/noAutofocus: the member just asked for a new book.
				<input aria-label="Book title" placeholder="Book title" autoFocus value={newTitle} maxLength={200} onChange={(e) => setNewTitle(e.target.value)} />
			)}
			{warning && <p role="alert">{warning.text}</p>}
			{error && (
				<p role="alert" className="error">
					{error}
				</p>
			)}
			<button type="button" className="primary" disabled={saving || (bookId === NEW_BOOK && !newTitle.trim())} onClick={() => void save()}>
				{saving ? 'Saving…' : (warning?.action ?? 'Save')}
			</button>
		</Frame>
	)
}

/** The toolbar popup: saves the page in the current tab to Life Log Club, on its own or as a book's next chapter. */
export function Popup() {
	const [state, setState] = useState<State>({ kind: 'loading' })
	useEffect(() => {
		void load().then(setState)
	}, [])

	if (state.kind === 'loading')
		return (
			<Frame>
				<p className="muted">Reading the page…</p>
			</Frame>
		)
	if (state.kind === 'problem')
		return (
			<Frame>
				<p className="muted">{state.text}</p>
				{state.action && (
					<button type="button" className="primary" onClick={state.action.run}>
						{state.action.label}
					</button>
				)}
			</Frame>
		)
	if (state.kind === 'saved')
		return (
			<Frame>
				<p role="status">{state.text}</p>
				<button type="button" className="primary" onClick={() => openApp(`/mind/read/${state.readingId}`)}>
					Open in Life Log Club
				</button>
			</Frame>
		)
	return <Ready page={state.page} onSaved={(saved) => setState({ kind: 'saved', ...saved })} />
}
