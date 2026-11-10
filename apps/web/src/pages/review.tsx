import { REPORT_REASONS, type AnswerResult, type ReviewFilter, type ReviewItem } from '@life-log-club/contract'
import { ORPCError } from '@orpc/client'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { type ReactNode, useState } from 'react'
import { type Answered, primary, QuestionForm, RevealTile, SelfRating } from '../answer'
import { quiet } from '../books'
import { client, errorMessage, orpc } from '../rpc'
import { ErrorText } from '../ui'

const BATCH = 20
const FILTERS: { value: ReviewFilter; label: string }[] = [
	{ value: 'all', label: 'All' },
	{ value: 'readings', label: 'Readings' },
	{ value: 'lessons', label: 'Lessons' },
	{ value: 'words', label: 'Words' },
]
const REASON_LABEL: Record<(typeof REPORT_REASONS)[number], string> = {
	wrong_answer: 'The answer is wrong',
	unclear: 'The question is unclear',
	not_in_text: 'It isn’t in the text',
}

/** One answered card, for the summary after the batch. */
type Reviewed = { item: ReviewItem; result: AnswerResult } & Answered

/** "Peak · Chapter 2" for an idea from a reading, "Lesson · 3 Nov" for a lesson. */
function sourceLine(item: ReviewItem) {
	if (item.source) return item.source.section ? `${item.source.reading} · ${item.source.section}` : item.source.reading
	const day = item.createdAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
	return `${item.kind === 'lesson' ? 'Lesson' : item.kind === 'word' ? 'Word' : 'Idea'} · ${day}`
}

/** Report a problem with a question: three reasons, one click each. The question is never asked again. */
function ReportProblem({ questionId, answerId, onReported }: { questionId: string; answerId?: string; onReported: () => void }) {
	const [open, setOpen] = useState(false)
	const report = useMutation({
		mutationFn: (reason: (typeof REPORT_REASONS)[number]) => client.questions.report({ id: questionId, reason, answerId }),
		onSuccess: onReported,
	})
	if (!open)
		return (
			<div>
				<button type="button" className="font-sans text-xs text-world-muted underline underline-offset-2" onClick={() => setOpen(true)}>
					Report a problem
				</button>
			</div>
		)
	return (
		<div className="grid gap-2 rounded-2xl border border-world-line p-3" role="group" aria-label="Report a problem">
			<p className="font-sans text-sm">What is wrong with this question?</p>
			<div className="flex flex-wrap gap-2">
				{REPORT_REASONS.map((r) => (
					<button key={r} type="button" className={quiet} disabled={report.isPending} onClick={() => report.mutate(r)}>
						{REASON_LABEL[r]}
					</button>
				))}
				<button type="button" className="font-sans text-sm text-world-muted" onClick={() => setOpen(false)}>
					Cancel
				</button>
			</div>
			<ErrorText>{report.error && errorMessage(report.error)}</ErrorText>
		</div>
	)
}

const Next = ({ onClick }: { onClick: () => void }) => (
	<div>
		{/* Focused, so Enter goes on. */}
		<button type="button" className={primary} autoFocus onClick={onClick}>
			Next
		</button>
	</div>
)

type Phase =
	| { kind: 'ask' }
	| { kind: 'result'; record: Reviewed }
	| { kind: 'self-check'; given: string }
	| { kind: 'shown' }
	| { kind: 'reported'; answered: boolean }
	| { kind: 'elsewhere' }

/**
 * One due card: ask, then the result at once. Items in Review come from different readings, so
 * one result can't hint at the next. A self-rated card shows its answer, then takes a rating.
 */
function ReviewCard({ item, mode, onDone }: { item: ReviewItem; mode: 'review' | 'practice'; onDone: (record: Reviewed | null) => void }) {
	const [phase, setPhase] = useState<Phase>({ kind: 'ask' })
	const [thought, setThought] = useState('')
	const questionId = item.ask.kind === 'question' ? item.ask.questionId : null
	const prompt = mode === 'practice' ? item.cue : item.ask.prompt
	const rated = (result: AnswerResult, answerId: string, given: string | null) => onDone({ item, result, answerId, given, confidence: null })

	let body: ReactNode
	if (phase.kind === 'result') {
		const { record } = phase
		body = (
			<>
				<RevealTile
					result={record.result}
					given={record.given}
					prompt={prompt}
					answerId={record.answerId}
					showDue={mode === 'review'}
					onOverride={(result) => setPhase({ kind: 'result', record: { ...record, result } })}
				/>
				{questionId && <ReportProblem questionId={questionId} answerId={record.answerId} onReported={() => setPhase({ kind: 'reported', answered: true })} />}
				<Next onClick={() => onDone(record)} />
			</>
		)
	} else if (phase.kind === 'reported') {
		body = (
			<>
				<p role="status" className="text-lg">
					Thanks. This question won’t be asked again{phase.answered ? ', and this answer doesn’t count' : ''}.
				</p>
				<Next onClick={() => onDone(null)} />
			</>
		)
	} else if (phase.kind === 'elsewhere') {
		body = (
			<>
				<p role="status" className="text-lg">
					Already answered on another device.
				</p>
				<Next onClick={() => onDone(null)} />
			</>
		)
	} else if (phase.kind === 'self-check' || phase.kind === 'shown') {
		body = (
			<>
				<p className="text-xl leading-snug" data-testid="question">
					{prompt}
				</p>
				{phase.kind === 'shown' && thought && <p className="whitespace-pre-wrap text-world-muted">You wrote: {thought}</p>}
				{phase.kind === 'self-check' && (
					<>
						<p role="status" className="text-world-muted">
							Your answer couldn’t be checked just now. Check it yourself.
						</p>
						<p className="whitespace-pre-wrap text-world-muted">You wrote: {phase.given}</p>
					</>
				)}
				<div className="rounded-2xl border border-world-line bg-world-card p-4" data-testid="answer">
					<p className="font-sans text-xs font-semibold tracking-wide text-world-muted uppercase">{item.kind === 'lesson' ? 'The lesson' : 'The idea'}</p>
					<p className="mt-1 text-lg leading-snug">{item.answer}</p>
				</div>
				<SelfRating cardId={item.cardId} mode={mode} onRated={(result, answerId) => rated(result, answerId, phase.kind === 'self-check' ? phase.given : thought || null)} />
			</>
		)
	} else if (item.ask.kind === 'self') {
		body = (
			<>
				<p className="text-xl leading-snug" data-testid="question">
					{prompt}
				</p>
				<textarea
					aria-label="Type it, or just think it"
					rows={3}
					maxLength={4000}
					value={thought}
					onChange={(e) => setThought(e.target.value)}
					placeholder="Type it, or just think it"
					className="w-full rounded-2xl border border-world-line bg-world-card p-4 text-lg leading-relaxed outline-none focus:border-world-accent"
				/>
				<div>
					{/* Focused, so Space shows the answer. */}
					<button type="button" className={primary} autoFocus onClick={() => setPhase({ kind: 'shown' })}>
						Show answer
					</button>
				</div>
			</>
		)
	} else {
		const ask = item.ask
		body = (
			<>
				<QuestionForm
					item={{ cardId: item.cardId, questionId, prompt, code: ask.kind === 'question' ? ask.code : null, options: ask.kind === 'question' ? ask.options : null }}
					mode={mode}
					keys
					onAnswered={(result, answered) => setPhase({ kind: 'result', record: { item, result, ...answered } })}
					onError={(error, given) => {
						if (error instanceof ORPCError && error.code === 'CONFLICT') setPhase({ kind: 'elsewhere' })
						else if (error instanceof ORPCError && error.code === 'SERVICE_UNAVAILABLE') setPhase({ kind: 'self-check', given })
					}}
				/>
				{questionId && mode === 'review' && <ReportProblem questionId={questionId} onReported={() => setPhase({ kind: 'reported', answered: false })} />}
			</>
		)
	}
	return (
		<article className="grid gap-4" aria-label="Review card">
			<p className="font-sans text-xs text-world-muted" data-testid="source">
				{sourceLine(item)}
			</p>
			{body}
		</article>
	)
}

/** After a batch: confident errors first, the right count, then Keep going, Retry missed ideas, Done. */
function Summary({
	records,
	more,
	onMore,
	onRetry,
}: {
	records: Reviewed[]
	more: boolean
	onMore: () => void
	onRetry: (() => void) | null
}) {
	const navigate = useNavigate()
	const right = records.filter((r) => r.result.correct).length
	// Sure but wrong first: the errors most worth fixing (hypercorrection).
	const sureWrong = records.filter((r) => !r.result.correct && r.confidence === 'sure')
	return (
		<div className="grid gap-6">
			<p className="text-xl">{records.length ? `You answered ${right} of ${records.length} right.` : 'That was the batch.'}</p>
			{sureWrong.length > 0 && (
				<section aria-label="You were sure about these" className="grid gap-2 rounded-2xl border border-red/30 bg-red/5 p-4">
					<h2 className="font-sans text-sm font-semibold">You were sure about these</h2>
					{sureWrong.map((r) => (
						<p key={r.answerId}>{r.item.answer}</p>
					))}
				</section>
			)}
			<div className="flex flex-wrap gap-3">
				{more && (
					<button type="button" className={primary} onClick={onMore}>
						Keep going
					</button>
				)}
				{onRetry && (
					<button type="button" className={quiet} onClick={onRetry}>
						Retry missed ideas
					</button>
				)}
				<button type="button" className={more ? quiet : primary} onClick={() => navigate({ to: '/mind' })}>
					Done
				</button>
			</div>
		</div>
	)
}

/** Retry missed ideas after a batch: each one asked again through its cue, as practice. The schedule stays. */
function Retry({ records, onDone }: { records: Reviewed[]; onDone: () => void }) {
	const [index, setIndex] = useState(0)
	const record = records[index]
	if (!record)
		return (
			<div className="grid gap-3">
				<p className="text-lg">That was every missed idea. They still come back on their own schedule.</p>
				<div>
					<button type="button" className={quiet} onClick={onDone}>
						Back to the summary
					</button>
				</div>
			</div>
		)
	return (
		<div className="grid gap-3">
			<p className="font-sans text-sm text-world-muted">
				Retry {index + 1} of {records.length} · practice, your schedule stays as it is
			</p>
			<ReviewCard key={record.answerId} item={{ ...record.item, ask: { kind: 'cue', prompt: record.item.cue } }} mode="practice" onDone={() => setIndex(index + 1)} />
		</div>
	)
}

/**
 * Review: due ideas one at a time, 20 to a batch, each answer checked and its result shown at
 * once. Lowest predicted recall first, mixing readings and lessons.
 */
export function Review({ first }: { first?: string }) {
	const queryClient = useQueryClient()
	const [filter, setFilter] = useState<ReviewFilter>('all')
	const [round, setRound] = useState(0)
	const [index, setIndex] = useState(0)
	const [records, setRecords] = useState<Reviewed[]>([])
	const [retrying, setRetrying] = useState(false)
	// One batch stays as it was fetched while the member works through it.
	const batch = useQuery({
		queryKey: ['review-batch', filter, round, first],
		// The card brought forward leads the first batch only.
		queryFn: () => client.review.next({ limit: BATCH, filter, first: round === 0 ? first : undefined }),
		staleTime: Number.POSITIVE_INFINITY,
		refetchOnWindowFocus: false,
	})
	const start = (next: { filter?: ReviewFilter }) => {
		if (next.filter) setFilter(next.filter)
		setRound(round + 1)
		setIndex(0)
		setRecords([])
		setRetrying(false)
	}

	const data = batch.data
	const item = data?.items[index]
	const missed = records.filter((r) => !r.result.correct && r.item.ask.kind !== 'self')
	return (
		<section className="mx-auto grid w-full max-w-2xl gap-6">
			<header className="grid gap-3">
				<Link to="/mind" className="font-sans text-sm text-world-muted">
					← The reading room
				</Link>
				<div className="grid gap-1">
					<h1 className="text-3xl font-semibold tracking-tight">Review</h1>
					{data && data.total > 0 && (
						<p className="font-sans text-sm text-world-muted" data-testid="review-total">
							{data.total} due · about {data.minutes} min
						</p>
					)}
				</div>
				<div className="flex flex-wrap gap-2" role="group" aria-label="Show">
					{FILTERS.map((f) => (
						<button
							key={f.value}
							type="button"
							aria-pressed={filter === f.value}
							className={`rounded-full border px-3 py-1 font-sans text-xs transition ${filter === f.value ? 'border-world-accent bg-world-accent text-world-on-accent' : 'border-world-line'}`}
							onClick={() => start({ filter: f.value })}
						>
							{f.label}
						</button>
					))}
				</div>
			</header>
			{batch.isError && <p role="alert">{errorMessage(batch.error)}</p>}
			{data && data.items.length === 0 && (
				<p className="text-lg">Nothing is due right now. Ideas come back here when it is time to recall them.</p>
			)}
			{data && item && (
				<div className="grid gap-3">
					<p className="font-sans text-sm text-world-muted">
						Card {index + 1} of {data.items.length}
					</p>
					<ReviewCard
						key={`${round}-${item.cardId}`}
						item={item}
						mode="review"
						onDone={(record) => {
							if (record) setRecords([...records, record])
							setIndex(index + 1)
							// The counts on Mind and Home follow each answer.
							void queryClient.invalidateQueries({ queryKey: orpc.review.due.key() })
						}}
					/>
				</div>
			)}
			{data && data.items.length > 0 && !item && (
				retrying ? (
					<Retry records={missed} onDone={() => setRetrying(false)} />
				) : (
					<Summary records={records} more={data.total > data.items.length} onMore={() => start({})} onRetry={missed.length ? () => setRetrying(true) : null} />
				)
			)}
		</section>
	)
}
