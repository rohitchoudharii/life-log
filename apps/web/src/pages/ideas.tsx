import type { SavedCard } from '@life-log-club/contract'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { client, errorMessage, orpc } from '../rpc'
import { useToast } from '../toast'

const DAY = 24 * 60 * 60 * 1000

/** "Due now", "Back tomorrow", "Back in 5 days", or the date when it is over a month away. Days are in UTC. */
function backIn(dueAt: Date, now = Date.now()) {
	const days = Math.ceil((dueAt.getTime() - now) / DAY)
	if (days <= 0) return 'Due now'
	if (days === 1) return 'Back tomorrow'
	if (days <= 31) return `Back in ${days} days`
	return `Back on ${dueAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })}`
}

/** Saved ideas grouped by reading, in the order of each reading's newest idea. */
function byReading(cards: SavedCard[]) {
	const groups = new Map<string, { title: string; cards: SavedCard[] }>()
	for (const c of cards) {
		if (!c.readingId) continue
		const group = groups.get(c.readingId) ?? { title: c.readingTitle ?? 'Untitled', cards: [] }
		group.cards.push(c)
		groups.set(c.readingId, group)
	}
	return [...groups].map(([id, g]) => ({ id, ...g }))
}

function IdeaCard({ card }: { card: SavedCard }) {
	const queryClient = useQueryClient()
	const toast = useToast()
	const [editing, setEditing] = useState(false)
	const ownWords = card.answer !== card.quote
	const [words, setWords] = useState(ownWords ? card.answer : '')
	const [question, setQuestion] = useState(card.prompt)
	const refresh = () => queryClient.invalidateQueries({ queryKey: orpc.review.key() })
	const update = useMutation({
		mutationFn: () => client.review.update({ id: card.id, prompt: question.trim() || undefined, answer: words.trim() || card.quote || undefined }),
		onSuccess: async () => {
			await refresh()
			setEditing(false)
		},
	})
	const remove = useMutation({
		mutationFn: () => client.review.remove({ id: card.id }),
		onSuccess: async () => {
			await refresh()
			toast({ text: 'Idea removed.', undo: () => void client.review.restore({ id: card.id }).then(refresh) })
		},
	})
	const field =
		'w-full rounded-lg border border-world-line bg-world px-3 py-2 font-sans text-base outline-none focus:border-world-accent focus:ring-2 focus:ring-world-accent/20'
	const small = 'rounded-lg px-2 py-1 font-sans text-sm text-world-muted transition hover:bg-world hover:text-world-ink'
	return (
		<li data-testid="saved-idea" className="grid gap-3 rounded-2xl border border-world-line bg-world-card p-4">
			<blockquote className="border-l-2 border-world-accent pl-3 leading-relaxed italic">{card.quote}</blockquote>
			{editing ? (
				<form
					className="grid gap-3"
					onSubmit={(e) => {
						e.preventDefault()
						update.mutate()
					}}
				>
					<label className="grid gap-1.5 font-sans text-sm">
						<span className="font-medium text-world-muted">In your words (optional)</span>
						<textarea className={`${field} min-h-20`} value={words} maxLength={5000} onChange={(e) => setWords(e.target.value)} />
					</label>
					<label className="grid gap-1.5 font-sans text-sm">
						<span className="font-medium text-world-muted">Question to ask yourself</span>
						<input className={field} value={question} maxLength={1000} onChange={(e) => setQuestion(e.target.value)} />
					</label>
					{update.error && (
						<p role="alert" className="font-sans text-sm text-red">
							{errorMessage(update.error)}
						</p>
					)}
					<div className="flex gap-2 font-sans">
						<button
							type="submit"
							disabled={update.isPending}
							className="rounded-xl bg-world-accent px-4 py-2 text-sm font-semibold text-world-on-accent transition hover:opacity-90 disabled:opacity-60"
						>
							Save
						</button>
						<button type="button" className={small} onClick={() => setEditing(false)}>
							Cancel
						</button>
					</div>
				</form>
			) : (
				<div className="grid gap-1 font-sans text-sm">
					{ownWords && (
						<p>
							<span className="text-world-muted">In your words: </span>
							{card.answer}
						</p>
					)}
					<p>
						<span className="text-world-muted">Asks: </span>
						{card.prompt}
					</p>
				</div>
			)}
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-sans text-sm">
				<span className="text-world-muted" data-testid="idea-due">
					{backIn(card.dueAt)}
				</span>
				{card.sectionTitle && <span className="text-world-muted">· {card.sectionTitle}</span>}
				<span className="flex-1" />
				{card.readingId && card.sectionId && (
					<Link
						to="/mind/read/$readingId"
						params={{ readingId: card.readingId }}
						search={{ section: card.sectionId, block: card.block ?? 0 }}
						className="rounded-lg px-2 py-1 text-world-accent underline-offset-2 hover:underline"
					>
						Open passage
					</Link>
				)}
				{!editing && (
					<button type="button" className={small} onClick={() => setEditing(true)}>
						Edit
					</button>
				)}
				<button type="button" className={small} disabled={remove.isPending} onClick={() => remove.mutate()}>
					Remove
				</button>
			</div>
		</li>
	)
}

/** Every idea the member saved while reading, grouped by reading, each linking back to its passage. */
export function Ideas() {
	const ideas = useQuery(orpc.review.list.queryOptions({ input: { origin: 'member', kind: 'idea' } }))
	const groups = byReading(ideas.data ?? [])
	return (
		<section className="mx-auto grid w-full max-w-3xl gap-6">
			<header className="grid gap-1">
				<Link to="/mind" className="font-sans text-sm text-world-muted">
					← The reading room
				</Link>
				<h1 className="text-3xl font-semibold tracking-tight">Ideas</h1>
				<p className="text-world-muted">The ideas you saved while reading. Each comes back in Review.</p>
			</header>
			{ideas.isError && <p role="alert">{errorMessage(ideas.error)}</p>}
			{ideas.isSuccess && !groups.length && (
				<p className="rounded-2xl border border-world-line bg-world-card p-5 text-world-muted">
					No saved ideas yet. Select a passage while you read, then press Save idea.
				</p>
			)}
			{groups.map((g) => (
				<section key={g.id} aria-labelledby={`ideas-${g.id}`} className="grid gap-3">
					<h2 id={`ideas-${g.id}`} className="text-xl">
						<Link to="/mind/read/$readingId" params={{ readingId: g.id }} className="hover:underline">
							{g.title}
						</Link>
					</h2>
					<ul className="grid gap-3">
						{g.cards.map((c) => (
							<IdeaCard key={c.id} card={c} />
						))}
					</ul>
				</section>
			))}
		</section>
	)
}
