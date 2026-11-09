import type { RecallAttempt } from '@life-log-club/contract'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { quiet } from '../books'
import { client, errorMessage, orpc } from '../rpc'
import { ErrorText } from '../ui'

const primary = 'rounded-xl bg-world-accent px-5 py-2 font-sans text-sm font-semibold text-world-on-accent transition hover:opacity-90 disabled:opacity-60'

const MARK: Record<'covered' | 'vague' | 'missing', { label: string; className: string }> = {
	covered: { label: 'Covered', className: 'bg-path/15 text-path' },
	vague: { label: 'Vague', className: 'bg-heart/25 text-ink' },
	missing: { label: 'Missed', className: 'bg-red/10 text-red' },
}

/** When a card comes back, in words: "Back in 10 minutes", "Back tomorrow", "Back in 3 days". */
export function backIn(dueAt: Date, now = new Date()) {
	// Rounded up, so a card due 10 minutes after grading still reads as 10 minutes a few seconds later.
	const minutes = Math.ceil((dueAt.getTime() - now.getTime()) / 60_000)
	if (minutes <= 1) return 'Back now'
	if (minutes < 60) return `Back in ${minutes} minutes`
	const days = Math.round(minutes / (24 * 60))
	if (days < 1) return `Back in ${Math.round(minutes / 60)} hours`
	return days === 1 ? 'Back tomorrow' : `Back in ${days} days`
}

/** The brain dump: the text hidden, one box for everything the member remembers. */
function Dump({ attempt }: { attempt: RecallAttempt }) {
	const queryClient = useQueryClient()
	const [text, setText] = useState('')
	const submit = useMutation({
		mutationFn: (dump: string) => client.recall.submit({ id: attempt.id, text: dump }),
		onSuccess: (next) => queryClient.setQueryData(orpc.recall.get.queryKey({ input: { id: attempt.id } }), next),
	})
	return (
		<form
			className="grid gap-4"
			onSubmit={(e) => {
				e.preventDefault()
				submit.mutate(text)
			}}
		>
			<label className="grid gap-2">
				<span className="font-sans text-sm text-world-muted">Write everything you remember. Lists and fragments are fine.</span>
				<textarea
					aria-label="What you remember"
					// The page exists for this one box.
					autoFocus
					rows={12}
					maxLength={20_000}
					value={text}
					onChange={(e) => setText(e.target.value)}
					className="w-full rounded-2xl border border-world-line bg-world-card p-4 text-lg leading-relaxed outline-none focus:border-world-accent"
				/>
			</label>
			<div className="flex flex-wrap items-center gap-3">
				<button type="submit" className={primary} disabled={submit.isPending || !text.trim()}>
					Done
				</button>
				<button type="button" className={quiet} disabled={submit.isPending} onClick={() => submit.mutate('')}>
					Nothing comes to mind
				</button>
			</div>
			<ErrorText>{submit.error && errorMessage(submit.error)}</ErrorText>
		</form>
	)
}

/** The recall map: every key idea, how the dump covered it, its quote and when it comes back. */
function Results({ attempt }: { attempt: RecallAttempt }) {
	const navigate = useNavigate()
	const ideas = attempt.ideas ?? []
	const covered = ideas.filter((i) => i.status === 'covered').length
	const done = async () => {
		if (attempt.nextSectionId) await client.readings.savePosition({ id: attempt.readingId, sectionId: attempt.nextSectionId, block: 0 })
		await navigate({ to: '/mind/read/$readingId', params: { readingId: attempt.readingId } })
	}
	return (
		<div className="grid gap-6">
			<div className="grid gap-1">
				<p className="font-sans text-sm text-world-muted">
					You brought back {covered} of {ideas.length} key {ideas.length === 1 ? 'idea' : 'ideas'}.
				</p>
				{attempt.feedback && <p className="text-lg">{attempt.feedback}</p>}
			</div>
			<ol aria-label="Recall map" className="grid gap-3">
				{ideas.map((idea) => (
					<li key={idea.cardId} className="grid gap-2 rounded-2xl border border-world-line bg-world-card p-4">
						<div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
							<p className="text-lg leading-snug">{idea.idea}</p>
							<span className={`rounded-full px-2.5 py-0.5 font-sans text-xs font-semibold ${MARK[idea.status].className}`}>{MARK[idea.status].label}</span>
						</div>
						{idea.quote && <p className="text-sm text-world-muted italic">From the text: “{idea.quote}”</p>}
						<p className="font-sans text-xs text-world-muted">{backIn(idea.dueAt)}</p>
					</li>
				))}
			</ol>
			{attempt.text ? (
				<details className="font-sans text-sm">
					<summary className="cursor-pointer text-world-muted">What you wrote</summary>
					<p className="mt-2 whitespace-pre-wrap">{attempt.text}</p>
				</details>
			) : null}
			<div>
				<button type="button" className={primary} onClick={done}>
					Done
				</button>
			</div>
		</div>
	)
}

/** A recall check on sections of a reading: the dump, the wait while it is checked, then the results. */
export function Recall({ attemptId }: { attemptId: string }) {
	const queryClient = useQueryClient()
	const attempt = useQuery({
		...orpc.recall.get.queryOptions({ input: { id: attemptId } }),
		refetchInterval: (query) => (query.state.data?.status === 'waiting' || query.state.data?.status === 'grading' ? 2000 : false),
	})
	const retry = useMutation({
		mutationFn: () => client.recall.retry({ id: attemptId }),
		onSuccess: (next) => queryClient.setQueryData(orpc.recall.get.queryKey({ input: { id: attemptId } }), next),
	})
	if (attempt.isError) return <p role="alert">{errorMessage(attempt.error)}</p>
	const a = attempt.data
	if (!a) return null
	return (
		<section className="mx-auto grid w-full max-w-2xl gap-6">
			<header className="grid gap-1">
				<Link to="/mind/read/$readingId" params={{ readingId: a.readingId }} className="font-sans text-sm text-world-muted">
					← {a.readingTitle}
				</Link>
				<p className="font-sans text-xs font-semibold tracking-wide text-world-muted uppercase">Recall</p>
				<h1 className="text-3xl font-semibold tracking-tight">{a.sections.map((s) => s.title).join(' · ')}</h1>
			</header>
			{a.status === 'open' && <Dump attempt={a} />}
			{(a.status === 'waiting' || a.status === 'grading') && (
				<p role="status" className="animate-pulse text-lg text-world-muted">
					Checking against the text…
				</p>
			)}
			{a.status === 'graded' && <Results attempt={a} />}
			{a.status === 'self' && (
				<p role="status" className="text-lg">
					Your recall is saved. Add your own AI key in{' '}
					<Link to="/settings" className="underline underline-offset-2">
						Settings
					</Link>{' '}
					to have it checked against the key ideas.
				</p>
			)}
			{a.status === 'failed' && (
				<div className="grid gap-3">
					<p role="alert">{a.feedback}</p>
					<div>
						<button type="button" className={quiet} disabled={retry.isPending} onClick={() => retry.mutate()}>
							Try again
						</button>
					</div>
				</div>
			)}
		</section>
	)
}
