import { MAX_FOLLOW_UPS, MAX_TEACH_CHARS } from '@life-log-club/domain'
import type { TeachSession } from '@life-log-club/contract'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { backIn, primary } from './answer'
import { quiet } from './books'
import { client, errorMessage, orpc } from './rpc'

/**
 * Teach it back: one click opens the dialog. It needs the member's AI key, so without one it
 * says so and leads to Settings, where the key is added.
 */
export function TeachBack({ cardId, className = quiet }: { cardId: string; className?: string }) {
	const key = useQuery(orpc.ai.getKey.queryOptions())
	const [open, setOpen] = useState(false)
	if (key.isPending) return null
	if (!key.data)
		return (
			<Link to="/settings" className={`${className} inline-block text-world-muted`}>
				Teach it back · Needs your AI key.
			</Link>
		)
	return (
		<>
			<button type="button" className={className} onClick={() => setOpen(true)}>
				Teach it back
			</button>
			{open && <TeachDialog cardId={cardId} onClose={() => setOpen(false)} />}
		</>
	)
}

/**
 * The learner explains an idea to a curious AI student, without the text. The student asks up to
 * three questions, one at a time, then says what was clear and what was missing, and only then
 * shows the idea to compare. Gaps bring the card back in 10 minutes.
 */
function TeachDialog({ cardId, onClose }: { cardId: string; onClose: () => void }) {
	const ref = useRef<HTMLDialogElement>(null)
	const queryClient = useQueryClient()
	const [id] = useState(() => crypto.randomUUID())
	const [draft, setDraft] = useState('')
	const [session, setSession] = useState<TeachSession | null>(null)
	useEffect(() => {
		ref.current?.showModal()
	}, [])
	const started = useQuery({ queryKey: ['teach', id], queryFn: () => client.teach.start({ id, cardId }), retry: false, staleTime: Number.POSITIVE_INFINITY })
	const current = session ?? started.data ?? null
	// The learner's messages so far; a failed turn is sent again with the same number, so it is kept once.
	const turn = current?.messages.filter((m) => m.role === 'learner').length ?? 0
	const reply = useMutation({
		mutationFn: (text: string) => client.teach.reply({ id, turn, text }),
		onSuccess: async (next) => {
			setSession(next)
			setDraft('')
			if (next.result) await queryClient.invalidateQueries({ queryKey: orpc.review.key() })
		},
	})
	const send = () => draft.trim() && !reply.isPending && reply.mutate(draft)
	const asked = current?.messages.filter((m) => m.role === 'student').length ?? 0
	const field = 'w-full rounded-2xl border border-world-line bg-world-card p-3 text-lg leading-relaxed outline-none focus:border-world-accent'
	return (
		<dialog
			ref={ref}
			aria-labelledby="teach-title"
			onClose={onClose}
			onClick={(e) => e.target === ref.current && onClose()}
			className="m-auto max-h-[calc(100dvh-2rem)] w-[min(100%-2rem,38rem)] rounded-2xl bg-world p-0 font-world text-world-ink shadow-2xl ring-1 ring-world-line backdrop:bg-black/30"
		>
			<div className="grid gap-4 p-5">
				<div className="flex items-center justify-between font-sans">
					<h2 id="teach-title" className="text-sm font-semibold">
						Teach it back
					</h2>
					<button type="button" onClick={onClose} className="rounded-lg px-2 py-1 text-sm text-world-muted hover:bg-world-card">
						Close <kbd className="ml-1 rounded border border-world-line px-1 text-xs">Esc</kbd>
					</button>
				</div>
				{started.isPending && <p className="animate-pulse font-sans text-sm text-world-muted">Getting the student ready…</p>}
				{started.isError && (
					<p role="alert" className="font-sans text-sm text-red">
						{errorMessage(started.error)}
					</p>
				)}
				{current && (
					<>
						<div className="grid gap-1">
							<p className="font-sans text-xs font-semibold tracking-wide text-world-muted uppercase">Teach this</p>
							<p className="text-xl leading-snug" data-testid="teach-topic">
								{current.topic}
							</p>
						</div>
						{current.messages.length === 0 && !reply.isPending && (
							<p className="font-sans text-sm text-world-muted">
								Explain it to a curious student who has not read it, in your own words and without the text. The student asks up to {MAX_FOLLOW_UPS} questions, then tells you
								what was clear and what was missing.
							</p>
						)}
						<ol aria-label="Conversation" className="grid gap-3">
							{current.messages.map((m, i) =>
								m.role === 'learner' ? (
									<li key={i} className="ml-8 justify-self-end rounded-2xl bg-world-accent/10 px-4 py-2.5 whitespace-pre-wrap">
										<span className="sr-only">You: </span>
										{m.text}
									</li>
								) : (
									<li key={i} className="mr-8 grid gap-0.5 rounded-2xl border border-world-line bg-world-card px-4 py-2.5" data-testid="student">
										<span className="font-sans text-xs text-world-muted">
											Student · question {current.messages.slice(0, i + 1).filter((x) => x.role === 'student').length} of {MAX_FOLLOW_UPS}
										</span>
										<span className="text-lg">{m.text}</span>
									</li>
								),
							)}
							{reply.isPending && (
								<>
									<li className="ml-8 justify-self-end rounded-2xl bg-world-accent/10 px-4 py-2.5 whitespace-pre-wrap">
										<span className="sr-only">You: </span>
										{reply.variables}
									</li>
									<li className="animate-pulse font-sans text-sm text-world-muted">{asked < MAX_FOLLOW_UPS ? 'The student is thinking…' : 'The student is summing up…'}</li>
								</>
							)}
						</ol>
						{current.result ? (
							<TeachResult result={current.result} onDone={onClose} />
						) : (
							!reply.isPending && (
								<form
									className="grid gap-3"
									onSubmit={(e) => {
										e.preventDefault()
										send()
									}}
								>
									<textarea
										aria-label={turn === 0 ? 'Your explanation' : 'Your answer'}
										placeholder={turn === 0 ? 'Explain it as you would to a friend…' : 'Answer the student…'}
										rows={turn === 0 ? 5 : 3}
										maxLength={MAX_TEACH_CHARS}
										value={draft}
										autoFocus
										onChange={(e) => setDraft(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
												e.preventDefault()
												send()
											}
										}}
										className={field}
									/>
									{reply.isError && (
										<p role="alert" className="font-sans text-sm text-red">
											{errorMessage(reply.error)}
										</p>
									)}
									<div className="flex items-center gap-3">
										<button type="submit" className={primary} disabled={!draft.trim()}>
											{reply.isError ? 'Try again' : 'Send'}
										</button>
										<span className="hidden font-sans text-xs text-world-muted sm:inline">⌘ Enter</span>
									</div>
								</form>
							)
						)}
					</>
				)}
			</div>
		</dialog>
	)
}

/** The student's summing up, then the idea itself to compare, and what happens to the card. */
function TeachResult({ result, onDone }: { result: NonNullable<TeachSession['result']>; onDone: () => void }) {
	const list = (title: string, items: string[], testId: string) => (
		<section aria-label={title} className="grid gap-1.5">
			<h3 className="font-sans text-xs font-semibold tracking-wide text-world-muted uppercase">{title}</h3>
			<ul className="grid list-disc gap-1 pl-5" data-testid={testId}>
				{items.map((item) => (
					<li key={item}>{item}</li>
				))}
			</ul>
		</section>
	)
	return (
		<div className="grid gap-4 rounded-2xl border border-world-line bg-world-card p-4" data-testid="teach-result">
			{result.summary && <p className="text-lg leading-snug">{result.summary}</p>}
			{result.strengths.length > 0 && list('What you explained well', result.strengths, 'strengths')}
			{result.gaps.length > 0 ? list('Gaps to fill', result.gaps, 'gaps') : <p className="font-sans text-sm">No gaps. Nicely taught.</p>}
			<div className="grid gap-1 border-t border-world-line pt-3">
				<p className="font-sans text-xs font-semibold tracking-wide text-world-muted uppercase">The idea</p>
				<p className="text-lg leading-snug">{result.idea}</p>
				{result.quote && <p className="text-sm text-world-muted italic">From the text: “{result.quote}”</p>}
			</div>
			<p className="font-sans text-sm text-world-muted" data-testid="teach-due">
				{result.dueAt ? `${backIn(result.dueAt)} in Review, so you can fill the gaps while they are fresh.` : 'Its schedule stays as it was.'}
			</p>
			<div>
				<button type="button" className={primary} autoFocus onClick={onDone}>
					Done
				</button>
			</div>
		</div>
	)
}
