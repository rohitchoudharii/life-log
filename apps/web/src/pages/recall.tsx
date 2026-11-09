import type { AnswerResult, RecallAttempt } from '@life-log-club/contract'
import type { PointStatus } from '@life-log-club/domain'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { quiet } from '../books'
import { backIn, primary, QuestionForm, RevealTile } from '../answer'
import { client, errorMessage, orpc } from '../rpc'
import { ErrorText } from '../ui'
import { SectionText } from './reader'

const MARK: Record<'covered' | 'vague' | 'missing', { label: string; className: string }> = {
	covered: { label: 'Covered', className: 'bg-path/15 text-path' },
	vague: { label: 'Vague', className: 'bg-heart/25 text-ink' },
	missing: { label: 'Missed', className: 'bg-red/10 text-red' },
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

/**
 * The questions after the dump, one per key idea, missed ideas first. No result shows until the
 * last answer, because the questions share one section and one answer could hint at the next.
 */
function Questions({ attempt }: { attempt: RecallAttempt }) {
	const queryClient = useQueryClient()
	const items = attempt.items ?? []
	const next = items.find((i) => !i.answered)
	if (!next) return null
	const n = items.indexOf(next) + 1
	return (
		<div className="grid gap-3">
			<p className="font-sans text-sm text-world-muted">
				Question {n} of {items.length}
			</p>
			<QuestionForm
				key={next.cardId}
				item={next}
				mode="recall"
				attemptId={attempt.id}
				selfCheck={attempt.selfCheck}
				onAnswered={() => queryClient.invalidateQueries({ queryKey: orpc.recall.get.queryKey({ input: { id: attempt.id } }) })}
			/>
		</div>
	)
}

/** Retry missed ideas: each one asked again through its cue, with its result at once. Practice only: the schedule stays. */
function Retry({ attempt, onDone }: { attempt: RecallAttempt; onDone: () => void }) {
	const queryClient = useQueryClient()
	const items = attempt.retry ?? []
	const [shown, setShown] = useState<{ result: AnswerResult; given: string | null; cardId: string } | null>(null)
	const next = items.find((i) => !i.answered)
	if (shown)
		return (
			<div className="grid gap-4">
				<RevealTile result={shown.result} given={shown.given} prompt={items.find((i) => i.cardId === shown.cardId)?.prompt} showDue={false} />
				<div>
					<button
						type="button"
						className={primary}
						onClick={async () => {
							await queryClient.invalidateQueries({ queryKey: orpc.recall.get.queryKey({ input: { id: attempt.id } }) })
							setShown(null)
						}}
					>
						Next
					</button>
				</div>
			</div>
		)
	if (!next)
		return (
			<div className="grid gap-3">
				<p className="text-lg">That was every missed idea. They still come back on their own schedule.</p>
				<div>
					<button type="button" className={quiet} onClick={onDone}>
						Back to the results
					</button>
				</div>
			</div>
		)
	return (
		<div className="grid gap-3">
			<p className="font-sans text-sm text-world-muted">
				Retry {items.indexOf(next) + 1} of {items.length} · practice, your schedule stays as it is
			</p>
			<QuestionForm key={next.cardId} item={next} mode="practice" attemptId={attempt.id} selfCheck={attempt.selfCheck} onAnswered={(result, { given }) => setShown({ result, given, cardId: next.cardId })} />
		</div>
	)
}

/** Done: back to the reader, at the section after the ones recalled. */
function useBackToReading(attempt: RecallAttempt) {
	const navigate = useNavigate()
	return async () => {
		if (attempt.nextSectionId) await client.readings.savePosition({ id: attempt.readingId, sectionId: attempt.nextSectionId, block: 0 })
		await navigate({ to: '/mind/read/$readingId', params: { readingId: attempt.readingId } })
	}
}

const SELF_MARKS: { status: PointStatus; label: string }[] = [
	{ status: 'covered', label: 'Got it' },
	{ status: 'vague', label: 'Partly' },
	{ status: 'missing', label: 'Missed' },
]

/**
 * Without an AI key: the dump beside the section's text, then one mark per key idea (Got it,
 * Partly or Missed, Missed until changed), which leads to the questions as AI grading does. A
 * section with no key ideas can only be compared.
 */
function SelfMark({ attempt }: { attempt: RecallAttempt }) {
	const queryClient = useQueryClient()
	const done = useBackToReading(attempt)
	const ideas = attempt.toMark ?? []
	const [marks, setMarks] = useState<Record<string, PointStatus>>({})
	const send = useMutation({
		mutationFn: () => client.recall.selfMark({ id: attempt.id, marks: ideas.map((i) => ({ cardId: i.cardId, status: marks[i.cardId] ?? 'missing' })) }),
		onSuccess: (next) => queryClient.setQueryData(orpc.recall.get.queryKey({ input: { id: attempt.id } }), next),
	})
	return (
		<div className="grid gap-6">
			<div className="grid gap-1">
				<h2 className="text-xl font-semibold">Compare with the text</h2>
				<p className="font-sans text-sm text-world-muted">
					{ideas.length
						? 'Look back at the section, then mark each key idea. Be strict: naming a term without saying what it means is Partly at best.'
						: 'There are no key ideas to mark in this section. Add your own AI key in Settings to have them written.'}
				</p>
			</div>
			<div className="grid items-start gap-4 md:grid-cols-2">
				<section aria-label="What you wrote" className="grid content-start gap-2 rounded-2xl border border-world-line bg-world-card p-4">
					<h3 className="font-sans text-xs font-semibold tracking-wide text-world-muted uppercase">What you wrote</h3>
					<p className="whitespace-pre-wrap">{attempt.text || 'Nothing came to mind.'}</p>
				</section>
				<section aria-label="The text" className="grid max-h-[32rem] content-start gap-6 overflow-y-auto rounded-2xl border border-world-line p-4">
					{attempt.sections.map((s) => (
						<SectionText key={s.id} id={s.id} />
					))}
				</section>
			</div>
			{ideas.length > 0 && (
				<ol aria-label="Key ideas" className="grid gap-3">
					{ideas.map((idea) => {
						const current = marks[idea.cardId] ?? 'missing'
						return (
							<li key={idea.cardId} className="grid gap-3 rounded-2xl border border-world-line bg-world-card p-4">
								<p className="text-lg leading-snug">{idea.idea}</p>
								<div role="radiogroup" aria-label="Your mark" className="flex flex-wrap gap-2">
									{SELF_MARKS.map((m) => (
										<button
											key={m.status}
											type="button"
											role="radio"
											aria-checked={current === m.status}
											onClick={() => setMarks((all) => ({ ...all, [idea.cardId]: m.status }))}
											className={`rounded-full border px-3 py-1 font-sans text-sm font-medium ${current === m.status ? `border-transparent font-semibold ${MARK[m.status].className}` : 'border-world-line text-world-muted hover:bg-world'}`}
										>
											{m.label}
										</button>
									))}
								</div>
							</li>
						)
					})}
				</ol>
			)}
			<div className="flex flex-wrap gap-3">
				{ideas.length > 0 ? (
					<button type="button" className={primary} disabled={send.isPending} onClick={() => send.mutate()}>
						Go on to the questions
					</button>
				) : (
					<button type="button" className={primary} onClick={done}>
						Done
					</button>
				)}
			</div>
			<ErrorText>{send.error && errorMessage(send.error)}</ErrorText>
		</div>
	)
}

/** The recall map: every key idea, how the dump covered it, its quote and when it comes back. */
function Results({ attempt }: { attempt: RecallAttempt }) {
	const queryClient = useQueryClient()
	const [retrying, setRetrying] = useState(false)
	const ideas = attempt.ideas ?? []
	const covered = ideas.filter((i) => i.status === 'covered').length
	const right = ideas.filter((i) => i.answer?.correct).length
	// Sure but wrong first: the errors most worth fixing (hypercorrection).
	const sureWrong = ideas.filter((i) => i.answer && !i.answer.correct && i.answer.confidence === 'sure')
	const retryLeft = (attempt.retry ?? []).some((i) => !i.answered)
	const done = useBackToReading(attempt)
	if (retrying) return <Retry attempt={attempt} onDone={() => setRetrying(false)} />
	return (
		<div className="grid gap-6">
			<div className="grid gap-1">
				<p className="font-sans text-sm text-world-muted">
					You brought back {covered} of {ideas.length} key {ideas.length === 1 ? 'idea' : 'ideas'}, and answered {right} of {ideas.length} questions right.
				</p>
				{attempt.feedback && <p className="text-lg">{attempt.feedback}</p>}
			</div>
			{sureWrong.length > 0 && (
				<section aria-label="You were sure about these" className="grid gap-2 rounded-2xl border border-red/30 bg-red/5 p-4">
					<h2 className="font-sans text-sm font-semibold">You were sure about these</h2>
					{sureWrong.map((i) => (
						<p key={i.cardId}>{i.idea}</p>
					))}
				</section>
			)}
			<ol aria-label="Recall map" className="grid gap-3">
				{ideas.map((idea) => (
					<li key={idea.cardId} className="grid gap-2 rounded-2xl border border-world-line bg-world-card p-4">
						<div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
							<p className="text-lg leading-snug">{idea.idea}</p>
							<span className={`rounded-full px-2.5 py-0.5 font-sans text-xs font-semibold ${MARK[idea.status].className}`}>{MARK[idea.status].label}</span>
						</div>
						{idea.answer ? (
							<RevealTile
								result={{ ...idea.answer, rating: 'good', dueAt: idea.dueAt }}
								given={idea.answer.given}
								prompt={idea.answer.prompt}
								answerId={idea.answer.answerId}
								onOverride={() => queryClient.invalidateQueries({ queryKey: orpc.recall.get.queryKey({ input: { id: attempt.id } }) })}
							/>
						) : (
							<>
								{idea.quote && <p className="text-sm text-world-muted italic">From the text: “{idea.quote}”</p>}
								<p className="font-sans text-xs text-world-muted">{backIn(idea.dueAt)}</p>
							</>
						)}
					</li>
				))}
			</ol>
			{attempt.text ? (
				<details className="font-sans text-sm">
					<summary className="cursor-pointer text-world-muted">What you wrote</summary>
					<p className="mt-2 whitespace-pre-wrap">{attempt.text}</p>
				</details>
			) : null}
			<div className="flex flex-wrap gap-3">
				<button type="button" className={primary} onClick={done}>
					Done
				</button>
				{retryLeft && (
					<button type="button" className={quiet} onClick={() => setRetrying(true)}>
						Retry missed ideas
					</button>
				)}
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
			{a.status === 'graded' && (a.ideas ? <Results attempt={a} /> : <Questions attempt={a} />)}
			{a.status === 'self' && <SelfMark attempt={a} />}
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
