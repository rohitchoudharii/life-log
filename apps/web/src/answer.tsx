import type { AnswerResult, AskItem } from '@life-log-club/contract'
import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { quiet } from './books'
import { client, errorMessage } from './rpc'
import { ErrorText } from './ui'

export const primary =
	'rounded-xl bg-world-accent px-5 py-2 font-sans text-sm font-semibold text-world-on-accent transition hover:opacity-90 disabled:opacity-60'

const CONFIDENCE = [
	{ value: 'guessing', label: 'Guessing' },
	{ value: 'think_so', label: 'Think so' },
	{ value: 'sure', label: 'Sure' },
] as const

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

/**
 * One written question or cue. The confidence buttons are the submit, so saying how sure you are
 * costs no click; I don't know is an honest miss. The answer id is picked once, so a retry of the
 * same answer counts once.
 */
export function QuestionForm({
	item,
	mode,
	attemptId,
	onAnswered,
}: {
	item: AskItem
	mode: 'recall' | 'review' | 'practice'
	attemptId?: string
	onAnswered: (result: AnswerResult, given: string | null) => void
}) {
	const [answerId] = useState(() => crypto.randomUUID())
	const [text, setText] = useState('')
	const send = useMutation({
		mutationFn: (choice: { confidence: (typeof CONFIDENCE)[number]['value'] | null; skipped?: boolean }) => {
			const response = choice.skipped ? { skipped: true as const } : { answer: text }
			const base = { answerId, cardId: item.cardId, mode, attemptId }
			return item.questionId
				? client.review.answer({ ...base, ask: 'question', questionId: item.questionId, response, confidence: choice.confidence })
				: client.review.answer({ ...base, ask: 'cue', response, confidence: choice.confidence })
		},
		onSuccess: (result, choice) => onAnswered(result, choice.skipped ? null : text),
	})
	const empty = !text.trim()
	return (
		<form className="grid gap-4" onSubmit={(e) => e.preventDefault()}>
			<p className="text-xl leading-snug" data-testid="question">
				{item.prompt}
			</p>
			{item.code && <pre className="overflow-x-auto rounded-xl bg-world-card p-3 text-sm whitespace-pre-wrap">{item.code}</pre>}
			<textarea
				aria-label="Your answer"
				// The page exists for this one box.
				autoFocus
				rows={5}
				maxLength={4000}
				value={text}
				onChange={(e) => setText(e.target.value)}
				className="w-full rounded-2xl border border-world-line bg-world-card p-4 text-lg leading-relaxed outline-none focus:border-world-accent"
			/>
			<div className="grid gap-2">
				<p className="font-sans text-xs text-world-muted">How sure are you?</p>
				<div className="flex flex-wrap items-center gap-2">
					{CONFIDENCE.map((c) => (
						<button key={c.value} type="button" className={primary} disabled={empty || send.isPending} onClick={() => send.mutate({ confidence: c.value })}>
							{c.label}
						</button>
					))}
					<button type="button" className={quiet} disabled={send.isPending} onClick={() => send.mutate({ confidence: null, skipped: true })}>
						I don’t know
					</button>
				</div>
			</div>
			{send.isPending && <p className="animate-pulse font-sans text-sm text-world-muted">Checking your answer…</p>}
			<ErrorText>{send.error && errorMessage(send.error)}</ErrorText>
		</form>
	)
}

const POINT = { covered: 'Made', vague: 'Vague', missing: 'Missed' } as const

/** The result of one answer: the verdict, the learner's own words, the points made or missed, the model answer and the quote. */
export function RevealTile({ result, given, prompt, showDue = true }: { result: AnswerResult; given: string | null; prompt?: string; showDue?: boolean }) {
	const { reveal } = result
	// A cue's one point is the model answer itself; the verdict already says whether it was made.
	const points = reveal.points.length === 1 && reveal.points[0]!.point === reveal.reference ? [] : reveal.points
	return (
		<div className="grid gap-3 rounded-2xl border border-world-line bg-world-card p-4" data-testid="result">
			<p className={`font-sans text-sm font-semibold ${result.correct ? 'text-path' : 'text-red'}`}>{result.correct ? 'Right' : given === null ? 'Not answered' : 'Not quite'}</p>
			{prompt && <p className="text-lg leading-snug">{prompt}</p>}
			{given !== null && <p className="whitespace-pre-wrap text-world-muted">You wrote: {given}</p>}
			{reveal.feedback && <p>{reveal.feedback}</p>}
			{reveal.misconception && <p className="text-red">Not right: {reveal.misconception}</p>}
			{points.length > 0 && (
				<ul className="grid gap-1 font-sans text-sm">
					{points.map((p) => (
						<li key={p.point} className="flex gap-2">
							<span className={`shrink-0 font-semibold ${p.status === 'covered' ? 'text-path' : p.status === 'vague' ? 'text-ink' : 'text-red'}`}>{POINT[p.status]}</span>
							<span>{p.point}</span>
						</li>
					))}
				</ul>
			)}
			{reveal.reference && (
				<p>
					<span className="font-sans text-xs font-semibold tracking-wide text-world-muted uppercase">Model answer </span>
					{reveal.reference}
				</p>
			)}
			{reveal.quote && <p className="text-sm text-world-muted italic">From the text: “{reveal.quote}”</p>}
			{showDue && <p className="font-sans text-xs text-world-muted">{backIn(result.dueAt)}</p>}
		</div>
	)
}
