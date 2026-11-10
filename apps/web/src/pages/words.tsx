import type { Word } from '@life-log-club/contract'
import { MAX_WORD_CHARS } from '@life-log-club/domain'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { backIn } from '../answer'
import { client, errorMessage, orpc } from '../rpc'
import { useToast } from '../toast'

/** What a word's next test asks, so the member sees where it stands. */
const NEXT: Record<Word['test'], string> = {
	word_cloze: 'Next: fill it into its sentence',
	word_meaning: 'Next: say what it means',
	word_use: 'Next: use it in a sentence of your own',
}

const field =
	'w-full rounded-lg border border-world-line bg-world px-3 py-2 font-sans text-base outline-none focus:border-world-accent focus:ring-2 focus:ring-world-accent/20'
const button = 'rounded-xl bg-world-accent px-4 py-2 font-sans text-sm font-semibold text-world-on-accent transition hover:opacity-90 disabled:opacity-60'
const small = 'rounded-lg px-2 py-1 font-sans text-sm text-world-muted transition hover:bg-world hover:text-world-ink'

/** Adds a word by hand: the word, and a sentence and its meaning when the member has them. Enter adds. */
function AddWord() {
	const queryClient = useQueryClient()
	const toast = useToast()
	const [form, setForm] = useState('')
	const [sentence, setSentence] = useState('')
	const [meaning, setMeaning] = useState('')
	const add = useMutation({
		mutationFn: () =>
			client.words.add({ id: crypto.randomUUID(), form: form.trim(), sentence: sentence.trim() || undefined, meaning: meaning.trim() || undefined }),
		onSuccess: async ({ word, existing }) => {
			await queryClient.invalidateQueries({ queryKey: orpc.words.key() })
			setForm('')
			setSentence('')
			setMeaning('')
			toast({ text: existing ? `“${word.word}” is in your words already.` : `Added “${word.word}”. It comes back tomorrow.` })
		},
	})
	return (
		<form
			aria-label="Add a word"
			className="grid gap-3 rounded-2xl border border-world-line bg-world-card p-4"
			onSubmit={(e) => {
				e.preventDefault()
				if (form.trim()) add.mutate()
			}}
		>
			<div className="grid gap-3 sm:grid-cols-[1fr_2fr]">
				<label className="grid gap-1.5 font-sans text-sm">
					<span className="font-medium text-world-muted">Word</span>
					<input className={field} value={form} maxLength={MAX_WORD_CHARS} onChange={(e) => setForm(e.target.value)} autoComplete="off" />
				</label>
				<label className="grid gap-1.5 font-sans text-sm">
					<span className="font-medium text-world-muted">A sentence that uses it (optional)</span>
					<input className={field} value={sentence} maxLength={600} onChange={(e) => setSentence(e.target.value)} />
				</label>
			</div>
			<label className="grid gap-1.5 font-sans text-sm">
				<span className="font-medium text-world-muted">What it means (optional with an AI key, which defines it for you)</span>
				<input className={field} value={meaning} maxLength={500} onChange={(e) => setMeaning(e.target.value)} />
			</label>
			{add.error && (
				<p role="alert" className="font-sans text-sm text-red">
					{errorMessage(add.error)}
				</p>
			)}
			<div>
				<button type="submit" className={button} disabled={!form.trim() || add.isPending}>
					{add.isPending ? 'Adding…' : 'Add'}
				</button>
			</div>
		</form>
	)
}

/** A meaning typed by the member, for a word the AI could not define or that has no key to define it. */
function MeaningForm({ word }: { word: Word }) {
	const queryClient = useQueryClient()
	const [meaning, setMeaning] = useState('')
	const save = useMutation({
		mutationFn: () => client.words.update({ id: word.id, meaning: meaning.trim() }),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.words.key() }),
	})
	return (
		<form
			className="flex flex-wrap items-center gap-2"
			onSubmit={(e) => {
				e.preventDefault()
				if (meaning.trim()) save.mutate()
			}}
		>
			<input
				aria-label={`What “${word.word}” means`}
				className={`${field} max-w-sm`}
				placeholder="Add what it means"
				value={meaning}
				maxLength={500}
				onChange={(e) => setMeaning(e.target.value)}
			/>
			<button type="submit" className={button} disabled={!meaning.trim() || save.isPending}>
				Save
			</button>
			{save.error && (
				<p role="alert" className="w-full font-sans text-sm text-red">
					{errorMessage(save.error)}
				</p>
			)}
		</form>
	)
}

function WordCard({ word }: { word: Word }) {
	const queryClient = useQueryClient()
	const toast = useToast()
	const refresh = () => queryClient.invalidateQueries({ queryKey: orpc.words.key() })
	const remove = useMutation({
		mutationFn: () => client.words.remove({ id: word.id }),
		onSuccess: async () => {
			await refresh()
			toast({ text: `“${word.word}” removed.`, undo: () => void client.words.restore({ id: word.id }).then(refresh) })
		},
	})
	return (
		<li data-testid="word" className="grid gap-2 rounded-2xl border border-world-line bg-world-card p-4">
			<p className="flex flex-wrap items-baseline gap-x-2">
				<span className="text-xl font-semibold">{word.word}</span>
				{word.form.toLowerCase() !== word.word.toLowerCase() && <span className="font-sans text-sm text-world-muted">met as “{word.form}”</span>}
			</p>
			{word.meaning ? (
				<p>{word.meaning}</p>
			) : word.defining ? (
				<p className="animate-pulse font-sans text-sm text-world-muted">Finding what it means…</p>
			) : (
				<MeaningForm word={word} />
			)}
			{word.sentence && <p className="text-world-muted italic">“{word.sentence}”</p>}
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-sans text-sm">
				<span className="text-world-muted" data-testid="word-due">
					{backIn(word.dueAt)}
				</span>
				<span className="text-world-muted" data-testid="word-test">
					· {NEXT[word.test]}
				</span>
				{word.readingId && word.readingTitle && (
					<Link
						to="/mind/read/$readingId"
						params={{ readingId: word.readingId }}
						search={word.sectionId ? { section: word.sectionId } : {}}
						className="text-world-muted underline-offset-2 hover:underline"
					>
						· {word.readingTitle}
					</Link>
				)}
				<span className="flex-1" />
				<button type="button" className={small} disabled={remove.isPending} onClick={() => remove.mutate()}>
					Remove
				</button>
			</div>
		</li>
	)
}

/** The member's vocabulary: add a word by hand, and every word with its meaning and sentence. */
export function Words() {
	const words = useQuery({
		...orpc.words.list.queryOptions(),
		// While the AI defines a word, look again shortly, so its meaning shows without a reload.
		refetchInterval: (q) => (q.state.data?.some((w) => w.defining) ? 2000 : false),
	})
	return (
		<section className="mx-auto grid w-full max-w-3xl gap-6">
			<header className="grid gap-1">
				<Link to="/mind" className="font-sans text-sm text-world-muted">
					← The reading room
				</Link>
				<h1 className="text-3xl font-semibold tracking-tight">Words</h1>
				<p className="text-world-muted">Words you met while reading, or added here. Each comes back in Review until it sticks.</p>
			</header>
			<AddWord />
			{words.isError && <p role="alert">{errorMessage(words.error)}</p>}
			{words.isSuccess && !words.data.length && (
				<p className="rounded-2xl border border-world-line bg-world-card p-5 text-world-muted">
					No words yet. Select a word while you read and press Add word, or type one above.
				</p>
			)}
			{words.data && words.data.length > 0 && (
				<ul aria-label="Your words" className="grid gap-3">
					{words.data.map((w) => (
						<WordCard key={w.id} word={w} />
					))}
				</ul>
			)}
		</section>
	)
}
