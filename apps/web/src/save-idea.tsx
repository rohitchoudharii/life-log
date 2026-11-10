import { MAX_EXPLAIN_CHARS, MAX_QUOTE_CHARS, type SavedCard } from '@life-log-club/contract'
import { MAX_WORD_CHARS } from '@life-log-club/domain'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ExplainDialog } from './explain'
import { client, errorMessage, orpc } from './rpc'
import { useToast } from './toast'
import { MeaningDialog, useWordAdded } from './word-dialogs'

/**
 * What a selection in the reader would save: its text, the sentence it starts in, where it
 * starts, and where to show the bar.
 */
type Picked = { quote: string; sentence: string; sectionId: string; block: number; top: number; left: number }

/** A selection keeps line breaks and spacing; quotes are compared as one run of text, as the server keeps them. */
const oneRun = (text: string) => text.replace(/\s+/g, ' ').trim()

/** The text of a range, without note markers, with a space between blocks so their words don't run together. */
function textOf(range: Range) {
	const copy = range.cloneContents()
	for (const sup of copy.querySelectorAll('sup')) sup.remove()
	for (const block of copy.querySelectorAll('[data-block], p, li, h2, h3, blockquote, pre, td, th')) block.append(' ')
	return oneRun(copy.textContent ?? '')
}

/**
 * The selection in a section of the reader, or null. A selection across sections belongs to the
 * section where it starts. A section still waiting for its headings is left out, because it is
 * split again when they arrive.
 */
function pick(): Picked | null {
	const selection = document.getSelection()
	if (!selection || selection.isCollapsed || !selection.rangeCount) return null
	const range = selection.getRangeAt(0)
	const start = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement
	if (start?.closest('dialog, input, textarea')) return null
	const article =
		start?.closest<HTMLElement>('article[data-section]') ??
		[...document.querySelectorAll<HTMLElement>('article[data-section]')].find((a) => range.intersectsNode(a))
	if (!article || article.dataset.pending !== undefined) return null
	const quote = textOf(range)
	if (!quote) return null
	const blockEl = start?.closest<HTMLElement>('[data-block]')
	const block = Number(blockEl?.dataset.block ?? 0)
	const rect = range.getBoundingClientRect()
	const sentence = blockEl ? sentenceAt(blockEl, range) : quote
	return { quote, sentence, sectionId: article.dataset.section!, block, top: rect.bottom + window.scrollY + 8, left: rect.left + window.scrollX }
}

/** The sentence of a block that a selection starts in, as one run of text. */
function sentenceAt(block: HTMLElement, range: Range) {
	const before = document.createRange()
	before.setStart(block, 0)
	before.setEnd(range.startContainer, range.startOffset)
	const at = before.toString().length
	const text = block.textContent ?? ''
	for (const s of new Intl.Segmenter(undefined, { granularity: 'sentence' }).segment(text))
		if (at >= s.index && at < s.index + s.segment.length) return oneRun(s.segment)
	return oneRun(text)
}

/** A selection that is a word or a short term, not a phrase or a passage: what Add word takes. */
const asWord = (quote: string) => {
	const word = quote.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
	return word && word.length <= MAX_WORD_CHARS && word.split(' ').length <= 3 && /^[\p{L}\p{N}'’ -]+$/u.test(word) ? word : null
}

/** The idea form: the quote, with the member's own words and question, both optional. Enter saves. */
function IdeaDialog({
	picked,
	saved,
	readingId,
	onClose,
}: { picked: Picked; saved: SavedCard | undefined; readingId: string; onClose: () => void }) {
	const ref = useRef<HTMLDialogElement>(null)
	const queryClient = useQueryClient()
	const toast = useToast()
	const [words, setWords] = useState(saved && saved.answer !== saved.quote ? saved.answer : '')
	const [question, setQuestion] = useState(saved?.prompt ?? '')
	useEffect(() => {
		ref.current?.showModal()
	}, [])
	const save = useMutation({
		mutationFn: async () => {
			const answer = words.trim() || undefined
			const prompt = question.trim() || undefined
			if (saved) return client.review.update({ id: saved.id, prompt, answer: answer ?? saved.quote ?? undefined })
			return client.review.add({ id: crypto.randomUUID(), kind: 'idea', readingId, sectionId: picked.sectionId, block: picked.block, quote: picked.quote, prompt, answer })
		},
		onSuccess: (card) => {
			void queryClient.invalidateQueries({ queryKey: orpc.review.key() })
			document.getSelection()?.removeAllRanges()
			onClose()
			if (saved) return toast({ text: 'Idea updated.' })
			toast({
				text: 'Idea saved. It comes back tomorrow.',
				undo: () => void client.review.remove({ id: card.id }).then(() => queryClient.invalidateQueries({ queryKey: orpc.review.key() })),
			})
		},
	})
	const field =
		'w-full rounded-lg border border-world-line bg-world px-3 py-2 font-sans text-base text-world-ink outline-none focus:border-world-accent focus:ring-2 focus:ring-world-accent/20'
	return (
		<dialog
			ref={ref}
			aria-labelledby="save-idea-title"
			onClose={onClose}
			onClick={(e) => e.target === ref.current && onClose()}
			className="m-auto w-[min(100%-2rem,32rem)] rounded-2xl bg-world p-0 font-world text-world-ink shadow-2xl ring-1 ring-world-line backdrop:bg-black/30"
		>
			<form
				className="grid gap-4 p-5"
				onSubmit={(e) => {
					e.preventDefault()
					save.mutate()
				}}
			>
				<div className="flex items-center justify-between font-sans">
					<h2 id="save-idea-title" className="text-sm font-semibold">
						{saved ? 'You saved this idea already' : 'Save idea'}
					</h2>
					<button type="button" onClick={onClose} className="rounded-lg px-2 py-1 text-sm text-world-muted hover:bg-world-card">
						Close <kbd className="ml-1 rounded border border-world-line px-1 text-xs">Esc</kbd>
					</button>
				</div>
				<blockquote className="max-h-40 overflow-y-auto border-l-2 border-world-accent pl-3 leading-relaxed italic">{picked.quote}</blockquote>
				<label className="grid gap-1.5 font-sans text-sm">
					<span className="font-medium text-world-muted">In your words (optional)</span>
					<textarea
						className={`${field} min-h-20`}
						value={words}
						maxLength={5000}
						onChange={(e) => setWords(e.target.value)}
						// Enter saves, as everywhere else in the form; Shift+Enter starts a new line.
						onKeyDown={(e) => {
							if (e.key === 'Enter' && !e.shiftKey) {
								e.preventDefault()
								e.currentTarget.form?.requestSubmit()
							}
						}}
					/>
				</label>
				<label className="grid gap-1.5 font-sans text-sm">
					<span className="font-medium text-world-muted">Question to ask yourself (optional)</span>
					<input className={field} value={question} maxLength={1000} onChange={(e) => setQuestion(e.target.value)} placeholder="Why does this matter?" />
				</label>
				{save.error && (
					<p role="alert" className="font-sans text-sm text-red">
						{errorMessage(save.error)}
					</p>
				)}
				<button
					type="submit"
					disabled={save.isPending}
					className="rounded-xl bg-world-accent px-5 py-2.5 font-sans text-sm font-semibold text-world-on-accent transition hover:opacity-90 disabled:opacity-60"
				>
					{save.isPending ? 'Saving…' : 'Save'}
				</button>
			</form>
		</dialog>
	)
}

/**
 * The bar under text selected in the reader: Save idea and Explain. Save idea opens the idea form;
 * a quote saved before opens that idea instead, to edit. Explain explains the passage over the
 * reader. A selection too long for either says so instead.
 */
export function SaveIdea({ readingId }: { readingId: string }) {
	const [picked, setPicked] = useState<Picked | null>(null)
	const [open, setOpen] = useState<{ picked: Picked; saved: SavedCard | undefined } | null>(null)
	const [explaining, setExplaining] = useState<Picked | null>(null)
	const [defining, setDefining] = useState<{ picked: Picked; form: string } | null>(null)
	const key = useQuery(orpc.ai.getKey.queryOptions())
	const added = useWordAdded()
	// With a key, Add word is one click: the AI defines the word in its sentence. Without one, the member says what it means.
	const addWord = useMutation({
		mutationFn: ({ picked, form }: { picked: Picked; form: string }) => client.words.add({ id: crypto.randomUUID(), form, sentence: picked.sentence, sectionId: picked.sectionId }),
		onSuccess: async (result) => {
			document.getSelection()?.removeAllRanges()
			setPicked(null)
			await added(result)
		},
	})
	const toast = useToast()
	// Asked when the form opens, so a cue the AI wrote since the save shows in it. Without an
	// answer the form opens as new, and the server still returns the first card.
	const openForm = async (p: Picked) => {
		const saved = await client.review.list({ readingId, origin: 'member', kind: 'idea' }).catch(() => [])
		setOpen({ picked: p, saved: saved.find((c) => c.quote === p.quote) })
	}
	useEffect(() => {
		// Waits for the selection to settle, so the button doesn't chase a drag.
		let timer: number | undefined
		const onChange = () => {
			window.clearTimeout(timer)
			timer = window.setTimeout(() => setPicked(pick()), 150)
		}
		document.addEventListener('selectionchange', onChange)
		return () => {
			window.clearTimeout(timer)
			document.removeEventListener('selectionchange', onChange)
		}
	}, [])

	// One idea fits a card; a few paragraphs can still be explained. A word is added, not saved as an idea.
	const word = picked && asWord(picked.quote)
	const canSave = picked && !word && picked.quote.length <= MAX_QUOTE_CHARS
	const canExplain = picked && picked.quote.length <= MAX_EXPLAIN_CHARS
	const barButton = 'px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/10 active:scale-[0.97]'
	// Keeps the selection while a button is pressed.
	const keepSelection = { onPointerDown: (e: React.PointerEvent) => e.preventDefault(), onMouseDown: (e: React.MouseEvent) => e.preventDefault() }
	return (
		<>
			{picked &&
				!open &&
				!explaining &&
				!defining &&
				createPortal(
					<div className="absolute z-40 font-sans" style={{ top: picked.top, left: Math.max(8, Math.min(picked.left, window.innerWidth - 220)) }}>
						{!canExplain ? (
							<p role="status" className="rounded-xl bg-navy px-3 py-2 text-sm text-white shadow-lg">
								Pick one idea, not a page.
							</p>
						) : (
							<div role="toolbar" aria-label="Selection" className="flex divide-x divide-white/20 overflow-hidden rounded-xl bg-navy shadow-lg">
								{word ? (
									<button
										type="button"
										{...keepSelection}
										disabled={addWord.isPending}
										onClick={() => {
											if (key.data) addWord.mutate({ picked, form: word }, { onError: (e) => toast({ text: errorMessage(e) }) })
											else setDefining({ picked, form: word })
										}}
										className={barButton}
									>
										Add word
									</button>
								) : canSave ? (
									<button type="button" {...keepSelection} onClick={() => void openForm(picked)} className={barButton}>
										Save idea
									</button>
								) : (
									<p role="status" className="px-3 py-2 text-sm text-white">
										Pick one idea, not a page.
									</p>
								)}
								<button type="button" {...keepSelection} onClick={() => setExplaining(picked)} className={barButton}>
									Explain
								</button>
							</div>
						)}
					</div>,
					document.body,
				)}
			{defining && (
				<MeaningDialog
					form={defining.form}
					sentence={defining.picked.sentence}
					sectionId={defining.picked.sectionId}
					onClose={() => {
						setDefining(null)
						setPicked(null)
					}}
				/>
			)}
			{explaining && (
				<ExplainDialog
					sectionId={explaining.sectionId}
					passage={explaining.quote}
					onSaveIdea={
						explaining.quote.length <= MAX_QUOTE_CHARS
							? () => {
									const p = explaining
									setExplaining(null)
									void openForm(p)
								}
							: undefined
					}
					onClose={() => setExplaining(null)}
				/>
			)}
			{open && (
				<IdeaDialog
					picked={open.picked}
					saved={open.saved}
					readingId={readingId}
					onClose={() => {
						setOpen(null)
						setPicked(null)
					}}
				/>
			)}
		</>
	)
}
