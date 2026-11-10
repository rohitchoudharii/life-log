import type { Suggestion } from '@life-log-club/contract'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { client, errorMessage, orpc } from './rpc'
import { useToast } from './toast'

/** The word as added: what the toast says, with Undo for a new one. */
export function useWordAdded() {
	const queryClient = useQueryClient()
	const toast = useToast()
	return async ({ word, existing }: Awaited<ReturnType<typeof client.words.add>>) => {
		await queryClient.invalidateQueries({ queryKey: orpc.words.key() })
		if (existing) return toast({ text: `“${word.word}” is in your words already.` })
		toast({
			text: word.meaning ? `Added “${word.word}”. It comes back tomorrow.` : `Added “${word.word}”. Its meaning comes in a moment.`,
			undo: () => void client.words.remove({ id: word.id }).then(() => queryClient.invalidateQueries({ queryKey: orpc.words.key() })),
		})
	}
}

function WordDialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
	const ref = useRef<HTMLDialogElement>(null)
	useEffect(() => {
		ref.current?.showModal()
	}, [])
	return (
		<dialog
			ref={ref}
			aria-label={title}
			onClose={onClose}
			onClick={(e) => e.target === ref.current && onClose()}
			className="m-auto w-[min(100%-2rem,28rem)] rounded-2xl bg-world p-0 font-world text-world-ink shadow-2xl ring-1 ring-world-line backdrop:bg-black/30"
		>
			<div className="grid gap-4 p-5">
				<div className="flex items-center justify-between font-sans">
					<p className="text-sm font-semibold">{title}</p>
					<button type="button" onClick={onClose} className="rounded-lg px-2 py-1 text-sm text-world-muted hover:bg-world-card">
						Close <kbd className="ml-1 rounded border border-world-line px-1 text-xs">Esc</kbd>
					</button>
				</div>
				{children}
			</div>
		</dialog>
	)
}

const primary = 'rounded-xl bg-world-accent px-5 py-2.5 font-sans text-sm font-semibold text-world-on-accent transition hover:opacity-90 disabled:opacity-60'

/**
 * A word the AI suggests in the reader: what it means in its sentence, and Keep, one click, to
 * review it from tomorrow. The meaning comes with the suggestion, so keeping it needs no key.
 */
export function TermDialog({ term, sectionId, onClose }: { term: Suggestion; sectionId: string; onClose: () => void }) {
	const queryClient = useQueryClient()
	const added = useWordAdded()
	const keep = useMutation({
		mutationFn: () => client.words.add({ id: crypto.randomUUID(), form: term.form, sentence: term.sentence, meaning: term.meaning, sectionId }),
		onSuccess: async (result) => {
			await queryClient.invalidateQueries({ queryKey: orpc.words.suggestions.key() })
			onClose()
			await added(result)
		},
	})
	return (
		<WordDialog title="A word worth knowing" onClose={onClose}>
			<p className="text-2xl font-semibold">{term.word}</p>
			<p className="text-lg">{term.meaning}</p>
			<p className="text-world-muted italic">“{term.sentence}”</p>
			{keep.error && (
				<p role="alert" className="font-sans text-sm text-red">
					{errorMessage(keep.error)}
				</p>
			)}
			<div className="flex flex-wrap items-center gap-3 font-sans">
				<button type="button" autoFocus className={primary} disabled={keep.isPending} onClick={() => keep.mutate()}>
					Keep
				</button>
				<p className="text-sm text-world-muted">It comes back in Review: fill it in, say what it means, then use it.</p>
			</div>
		</WordDialog>
	)
}

/**
 * Add word without an AI key: the member says what the word means, since nothing can define it
 * for them. The word and its sentence come from the selection. Enter adds.
 */
export function MeaningDialog({ form, sentence, sectionId, onClose }: { form: string; sentence: string; sectionId: string; onClose: () => void }) {
	const added = useWordAdded()
	const [meaning, setMeaning] = useState('')
	const add = useMutation({
		mutationFn: () => client.words.add({ id: crypto.randomUUID(), form, sentence, sectionId, meaning: meaning.trim() }),
		onSuccess: async (result) => {
			onClose()
			await added(result)
		},
	})
	return (
		<WordDialog title="Add word" onClose={onClose}>
			<p className="text-2xl font-semibold">{form}</p>
			<p className="text-world-muted italic">“{sentence}”</p>
			<form
				className="grid gap-3"
				onSubmit={(e) => {
					e.preventDefault()
					if (meaning.trim()) add.mutate()
				}}
			>
				<label className="grid gap-1.5 font-sans text-sm">
					<span className="font-medium text-world-muted">What it means here</span>
					<input
						autoFocus
						value={meaning}
						maxLength={500}
						onChange={(e) => setMeaning(e.target.value)}
						className="w-full rounded-lg border border-world-line bg-world px-3 py-2 font-sans text-base outline-none focus:border-world-accent focus:ring-2 focus:ring-world-accent/20"
					/>
				</label>
				{add.error && (
					<p role="alert" className="font-sans text-sm text-red">
						{errorMessage(add.error)}
					</p>
				)}
				<div>
					<button type="submit" className={primary} disabled={!meaning.trim() || add.isPending}>
						Add
					</button>
				</div>
			</form>
		</WordDialog>
	)
}
