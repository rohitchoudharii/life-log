import type { AnswerResult, AskItem } from '@life-log-club/contract'
import { parseNumber } from '@life-log-club/domain'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { quiet } from './books'
import { client, errorMessage, orpc } from './rpc'
import { ErrorText } from './ui'

export const primary =
	'rounded-xl bg-world-accent px-5 py-2 font-sans text-sm font-semibold text-world-on-accent transition hover:opacity-90 disabled:opacity-60'

const CONFIDENCE = [
	{ value: 'guessing', label: 'Guessing', key: '1' },
	{ value: 'think_so', label: 'Think so', key: '2' },
	{ value: 'sure', label: 'Sure', key: '3' },
] as const
export type Confidence = (typeof CONFIDENCE)[number]['value']

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
 * Answer keys for the card on screen, such as 1 to 3 for confidence. They are caught before the
 * shell's own shortcuts, so 1 answers instead of switching worlds, and never while typing.
 */
export function useAnswerKeys(keys: Record<string, () => void>, active = true) {
	const current = useRef(keys)
	current.current = keys
	useEffect(() => {
		if (!active) return
		function onKey(e: KeyboardEvent) {
			if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return
			if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"], dialog')) return
			const run = current.current[e.key]
			if (!run) return
			e.preventDefault()
			run()
		}
		window.addEventListener('keydown', onKey, true)
		return () => window.removeEventListener('keydown', onKey, true)
	}, [active])
}

export type Answered = { answerId: string; given: string | null; confidence: Confidence | null }

/**
 * Guess first: type a few words before multiple-choice options show. One value for the member,
 * on by default, changed from the recall and Review start screens and from Settings.
 */
export function useGuessFirst() {
	const queryClient = useQueryClient()
	const prefs = useQuery(orpc.preferences.get.queryOptions())
	// The switch moves at once, without waiting for the save; a failed save moves it back.
	const [draft, setDraft] = useState<boolean | null>(null)
	const save = useMutation(
		orpc.preferences.update.mutationOptions({
			onError: () => setDraft(null),
			onSuccess: (saved) => queryClient.setQueryData(orpc.preferences.get.queryKey(), saved),
		}),
	)
	const on = draft ?? prefs.data?.guessFirst ?? true
	const set = (guessFirst: boolean) => {
		setDraft(guessFirst)
		save.mutate({ guessFirst })
	}
	return { on, set, error: save.error }
}

/** The Guess first switch, the same value wherever it shows. */
export function GuessFirstSwitch({ className = '' }: { className?: string }) {
	const guessFirst = useGuessFirst()
	return (
		<div className={`grid gap-1 ${className}`}>
			<label className="flex cursor-pointer items-center gap-2 font-sans text-sm">
				<input type="checkbox" role="switch" className="size-4 accent-world-accent" checked={guessFirst.on} onChange={(e) => guessFirst.set(e.target.checked)} />
				<span>
					<span className="font-medium">Guess first</span>
					<span className="text-world-muted"> · type a few words before the options show</span>
				</span>
			</label>
			<ErrorText>{guessFirst.error && errorMessage(guessFirst.error)}</ErrorText>
		</div>
	)
}

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']

/**
 * One question or cue: written, a choice of options, steps to put in order, a number with its
 * working, or the output of a piece of code. The confidence buttons are the submit, so saying how
 * sure you are costs no click; I don't know is an honest miss. The answer id is picked once, so a
 * retry of the same answer counts once. With `keys`, 1 to 3 pick the confidence once the box is
 * left, and letters pick an option or place the next step. With `selfCheck` (no AI key), the
 * learner then ticks the model answer's points they made, and a written answer is graded from the
 * ticks; a choice, an order, a number and an output are always checked against their key.
 */
export function QuestionForm({
	item,
	mode,
	attemptId,
	keys = false,
	selfCheck = false,
	onAnswered,
	onError,
}: {
	item: Pick<AskItem, 'cardId' | 'questionId' | 'prompt' | 'code'> & { options?: string[] | null; type?: string | null; unit?: string | null }
	mode: 'recall' | 'review' | 'practice'
	attemptId?: string
	keys?: boolean
	selfCheck?: boolean
	onAnswered: (result: AnswerResult, answer: Answered) => void
	/** Handles a failed answer instead of showing its message under the form. */
	onError?: (error: unknown, given: string) => void
}) {
	const [answerId] = useState(() => crypto.randomUUID())
	const [text, setText] = useState('')
	const [working, setWorking] = useState('')
	const [picked, setPicked] = useState<number | null>(null)
	// An order question: positions in the shown list, in the order the member tapped them.
	const [order, setOrder] = useState<number[]>([])
	const [guess, setGuess] = useState('')
	const [guessed, setGuessed] = useState(false)
	const [checking, setChecking] = useState<{ confidence: Confidence } | null>(null)
	const { options } = item
	// A worked problem is answered with a number, a predicted output with exactly what the code prints.
	const form =
		item.type === 'worked_problem' ? 'number' : item.type === 'predict_output' ? 'output' : item.type === 'order_steps' ? 'order' : options ? 'choice' : 'written'
	const exact = form === 'number' || form === 'output'
	const guessFirst = useGuessFirst().on
	// With Guess first, the options wait behind the member's own few words.
	const hidden = form === 'choice' && guessFirst && !guessed
	const given = form === 'order' ? order.map((i) => options![i]!).join(' → ') : options ? (picked === null ? '' : options[picked]!) : text
	const place = (i: number) => setOrder((o) => (o.includes(i) ? o : [...o, i]))
	const send = useMutation({
		mutationFn: (choice: { confidence: Confidence | null; skipped?: boolean; made?: boolean[] }) => {
			const base = { answerId, cardId: item.cardId, mode, attemptId }
			if (item.questionId) {
				const response = choice.skipped
					? { skipped: true }
					: form === 'order'
						? { order }
						: form === 'choice'
						? { choice: picked, ...(guessed && guess.trim() && { guess: guess.trim() }) }
						: form === 'number'
							? { value: text.trim(), ...(working.trim() && { working: working.trim() }) }
							: form === 'output'
								? { output: text }
								: { answer: text, ...(choice.made && { made: choice.made }) }
				return client.review.answer({ ...base, ask: 'question', questionId: item.questionId, response, confidence: choice.confidence })
			}
			const response = choice.skipped ? { skipped: true as const } : { answer: text, ...(choice.made && { made: choice.made }) }
			return client.review.answer({ ...base, ask: 'cue', response, confidence: choice.confidence })
		},
		onSuccess: (result, choice) => onAnswered(result, { answerId, given: choice.skipped ? null : given, confidence: choice.confidence }),
		onError: (error) => onError?.(error, given),
	})
	// A number the check can't read is a slip of format, not of knowledge, so it is caught before it counts.
	const unreadable = form === 'number' && text.trim() !== '' && parseNumber(text) === null
	const empty = form === 'order' ? order.length !== options!.length : options ? picked === null : !text.trim() || unreadable
	const pick = (confidence: Confidence) => {
		if (empty || send.isPending) return
		if (selfCheck && !options && !exact) setChecking({ confidence })
		else send.mutate({ confidence })
	}
	useAnswerKeys(
		{
			...Object.fromEntries(CONFIDENCE.map((c) => [c.key, () => pick(c.value)])),
			...Object.fromEntries((hidden ? [] : (options ?? [])).map((_, i) => [LETTERS[i]!.toLowerCase(), () => (form === 'order' ? place(i) : setPicked(i))])),
		},
		keys && !checking,
	)
	if (checking)
		return (
			<SelfCheck
				item={item}
				given={text}
				pending={send.isPending}
				error={send.error && !onError ? errorMessage(send.error) : null}
				onDone={(made) => send.mutate({ confidence: checking.confidence, made })}
			/>
		)
	return (
		<form className="grid gap-4" onSubmit={(e) => e.preventDefault()}>
			<p className="text-xl leading-snug" data-testid="question">
				{item.prompt}
			</p>
			{item.code && <pre className="overflow-x-auto rounded-xl bg-world-card p-3 text-sm whitespace-pre-wrap">{item.code}</pre>}
			{hidden ? (
				<div className="grid gap-3">
					<textarea
						aria-label="Your answer in a few words"
						autoFocus
						rows={2}
						maxLength={500}
						value={guess}
						onChange={(e) => setGuess(e.target.value)}
						placeholder="Your answer in a few words"
						className="w-full rounded-2xl border border-world-line bg-world-card p-4 text-lg leading-relaxed outline-none focus:border-world-accent"
					/>
					<div className="flex flex-wrap items-center gap-2">
						<button type="button" className={primary} disabled={!guess.trim()} onClick={() => setGuessed(true)}>
							Show options
						</button>
						<button type="button" className={quiet} disabled={send.isPending} onClick={() => send.mutate({ confidence: null, skipped: true })}>
							I don’t know
						</button>
					</div>
				</div>
			) : form === 'order' ? (
				<div className="grid gap-3">
					<p className="font-sans text-sm text-world-muted">Tap the steps from first to last. Tap a placed step to take it back.</p>
					{order.length > 0 && (
						<ol aria-label="Your order" className="grid gap-2">
							{order.map((i, k) => (
								<li key={i}>
									<button
										type="button"
										aria-label={`Take back: ${options![i]}`}
										onClick={() => setOrder((o) => o.filter((x) => x !== i))}
										className="flex w-full items-start gap-3 rounded-2xl border border-world-accent bg-world-card p-3 text-left text-lg leading-snug"
									>
										<span aria-hidden className="mt-0.5 w-5 shrink-0 font-sans text-sm font-semibold text-world-accent">
											{k + 1}
										</span>
										<span>{options![i]}</span>
									</button>
								</li>
							))}
						</ol>
					)}
					{order.length < options!.length && (
						<div role="group" aria-label="Steps to place" className="grid gap-2">
							{options!.map((step, i) =>
								order.includes(i) ? null : (
									<button
										key={i}
										type="button"
										onClick={() => place(i)}
										className="flex items-start gap-3 rounded-2xl border border-dashed border-world-line bg-world-card/60 p-3 text-left text-lg leading-snug transition hover:border-world-accent"
									>
										<span aria-hidden className="mt-0.5 w-5 shrink-0 font-sans text-sm font-semibold text-world-muted">
											{LETTERS[i]}
										</span>
										<span>{step}</span>
									</button>
								),
							)}
						</div>
					)}
					{order.length > 0 && (
						<div>
							<button type="button" className={quiet} onClick={() => setOrder([])}>
								Start over
							</button>
						</div>
					)}
				</div>
			) : options ? (
				<div role="radiogroup" aria-label="Options" className="grid gap-2">
					{guessed && guess.trim() && <p className="font-sans text-sm text-world-muted">Your guess: {guess.trim()}</p>}
					{options.map((option, i) => (
						<button
							key={i}
							type="button"
							role="radio"
							aria-checked={picked === i}
							onClick={() => setPicked(i)}
							className="flex items-start gap-3 rounded-2xl border border-world-line bg-world-card p-4 text-left text-lg leading-snug transition hover:border-world-accent aria-checked:border-world-accent aria-checked:ring-2 aria-checked:ring-world-accent/30"
						>
							<span aria-hidden className="mt-0.5 font-sans text-sm font-semibold text-world-muted">
								{LETTERS[i]}
							</span>
							<span>{option}</span>
						</button>
					))}
				</div>
			) : form === 'number' ? (
				<div className="grid gap-3">
					<label className="grid gap-1">
						<span className="font-sans text-xs text-world-muted">Your answer, as a number</span>
						<span className="flex items-center gap-2">
							<input
								aria-label="Your answer"
								autoFocus
								inputMode="decimal"
								autoComplete="off"
								maxLength={200}
								value={text}
								onChange={(e) => setText(e.target.value)}
								className="w-48 rounded-2xl border border-world-line bg-world-card px-4 py-3 text-lg outline-none focus:border-world-accent"
							/>
							{item.unit && <span className="text-lg text-world-muted">{item.unit}</span>}
						</span>
						{unreadable && <span className="font-sans text-sm text-red">Write it as a number, such as 27 or 0.5.</span>}
					</label>
					<label className="grid gap-1">
						<span className="font-sans text-xs text-world-muted">Your working (optional: it shows where a slip happened)</span>
						<textarea
							aria-label="Your working"
							rows={3}
							maxLength={4000}
							value={working}
							onChange={(e) => setWorking(e.target.value)}
							className="w-full rounded-2xl border border-world-line bg-world-card p-4 leading-relaxed outline-none focus:border-world-accent"
						/>
					</label>
				</div>
			) : form === 'output' ? (
				<label className="grid gap-1">
					<span className="font-sans text-xs text-world-muted">Exactly what it prints, one line per line</span>
					<textarea
						aria-label="What it prints"
						autoFocus
						rows={4}
						maxLength={4000}
						spellCheck={false}
						value={text}
						onChange={(e) => setText(e.target.value)}
						className="w-full rounded-2xl border border-world-line bg-world-card p-4 font-mono text-base leading-relaxed outline-none focus:border-world-accent"
					/>
				</label>
			) : (
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
			)}
			{!hidden && (
				<div className="grid gap-2">
					<p className="font-sans text-xs text-world-muted">How sure are you?</p>
					<div className="flex flex-wrap items-center gap-2">
						{CONFIDENCE.map((c) => (
							<button key={c.value} type="button" className={primary} disabled={empty || send.isPending} onClick={() => pick(c.value)}>
								{c.label}
							</button>
						))}
						<button type="button" className={quiet} disabled={send.isPending} onClick={() => send.mutate({ confidence: null, skipped: true })}>
							I don’t know
						</button>
					</div>
				</div>
			)}
			{send.isPending && <p className="animate-pulse font-sans text-sm text-world-muted">Checking your answer…</p>}
			{!onError && <ErrorText>{send.error && errorMessage(send.error)}</ErrorText>}
		</form>
	)
}

/**
 * Without an AI key, the learner checks their own written answer: the model answer, then a box
 * for each point a complete answer makes. A cue's one point is the idea itself.
 */
function SelfCheck({
	item,
	given,
	pending,
	error,
	onDone,
}: {
	item: Pick<AskItem, 'cardId' | 'questionId' | 'prompt'>
	given: string
	pending: boolean
	error: string | null
	onDone: (made: boolean[]) => void
}) {
	const checklist = useQuery(orpc.review.checklist.queryOptions({ input: { cardId: item.cardId, questionId: item.questionId } }))
	const [made, setMade] = useState<boolean[]>([])
	const data = checklist.data
	const onePoint = data?.points.length === 1 && data.points[0] === data.reference
	return (
		<form
			className="grid gap-4"
			onSubmit={(e) => {
				e.preventDefault()
				if (data) onDone(data.points.map((_, i) => made[i] ?? false))
			}}
		>
			<p className="text-xl leading-snug" data-testid="question">
				{item.prompt}
			</p>
			<p className="whitespace-pre-wrap text-world-muted">You wrote: {given}</p>
			{checklist.isError && <p role="alert">{errorMessage(checklist.error)}</p>}
			{data && (
				<div className="grid gap-3 rounded-2xl border border-world-line bg-world-card p-4" data-testid="checklist">
					{!onePoint && (
						<p>
							<span className="font-sans text-xs font-semibold tracking-wide text-world-muted uppercase">Model answer </span>
							{data.reference}
						</p>
					)}
					<fieldset className="grid gap-2">
						<legend className="mb-1 font-sans text-sm font-semibold">{onePoint ? 'Did your answer say this?' : 'Tick each point your answer made'}</legend>
						{data.points.map((point, i) => (
							<label key={point} className="flex items-start gap-2">
								<input
									type="checkbox"
									className="mt-1.5 size-4 shrink-0 accent-world-accent"
									checked={made[i] ?? false}
									onChange={(e) => setMade((m) => Object.assign([...m], { [i]: e.target.checked }))}
								/>
								<span>{point}</span>
							</label>
						))}
					</fieldset>
					{data.quote && <p className="text-sm text-world-muted italic">From the text: “{data.quote}”</p>}
				</div>
			)}
			<div>
				<button type="submit" className={primary} disabled={!data || pending}>
					Done
				</button>
			</div>
			<ErrorText>{error}</ErrorText>
		</form>
	)
}

const RATINGS = [
	{ value: 'again', label: 'Forgot', key: '1' },
	{ value: 'hard', label: 'Hard', key: '2' },
	{ value: 'good', label: 'Got it', key: '3' },
] as const

/** Forgot, Hard and Got it (keys 1 to 3): the learner's own rating, sent as one self-rated answer. */
export function SelfRating({ cardId, mode, onRated }: { cardId: string; mode: 'review' | 'practice'; onRated: (result: AnswerResult, answerId: string) => void }) {
	const [answerId] = useState(() => crypto.randomUUID())
	const rate = useMutation({
		mutationFn: (rating: (typeof RATINGS)[number]['value']) => client.review.answer({ answerId, cardId, mode, ask: 'self', rating }),
		onSuccess: (result) => onRated(result, answerId),
	})
	useAnswerKeys(Object.fromEntries(RATINGS.map((r) => [r.key, () => !rate.isPending && rate.mutate(r.value)])))
	return (
		<div className="grid gap-2">
			<p className="font-sans text-xs text-world-muted">How did it go?</p>
			<div className="flex flex-wrap gap-2">
				{RATINGS.map((r) => (
					<button key={r.value} type="button" className={r.value === 'good' ? primary : quiet} disabled={rate.isPending} onClick={() => rate.mutate(r.value)}>
						{r.label}
					</button>
				))}
			</div>
			<ErrorText>{rate.error && errorMessage(rate.error)}</ErrorText>
		</div>
	)
}

const POINT = { covered: 'Made', vague: 'Vague', missing: 'Missed' } as const

/**
 * The result of one answer: the verdict, the learner's own words, the points made or missed, the
 * model answer and the quote. With `answerId`, a written answer marked wrong offers Count it as
 * right, once.
 */
/** How many pairs of steps the learner put in the right relative order, out of all pairs. */
function pairsCount({ steps, pairs }: { steps: string[]; pairs: number }) {
	const total = (steps.length * (steps.length - 1)) / 2
	return { right: Math.round(pairs * total), total }
}

const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`

export function RevealTile({
	result: initial,
	given,
	prompt,
	showDue = true,
	answerId,
	onOverride,
}: {
	result: AnswerResult
	given: string | null
	prompt?: string
	showDue?: boolean
	answerId?: string
	onOverride?: (result: AnswerResult) => void
}) {
	const override = useMutation({
		mutationFn: (id: string) => client.review.override({ answerId: id }),
		onSuccess: (next) => onOverride?.(next),
	})
	const result = override.data ?? initial
	const { reveal } = result
	// A cue's one point is the model answer itself; the verdict already says whether it was made.
	const points = reveal.points.length === 1 && reveal.points[0]!.point === reveal.reference ? [] : reveal.points
	const { choice, exact, order } = reveal
	const answered = choice ? choice.picked !== null : exact ? exact.given !== null : order ? order.given !== null : given !== null
	// Partial credit by pairs: most pairs in order is close, and says so.
	const pairs = order && order.given ? pairsCount(order) : null
	// Output is compared line by line, so it reads in the code's own type.
	const mono = exact?.kind === 'output' ? 'font-mono text-sm' : ''
	const verdict = result.overridden
		? 'Counted as right'
		: result.correct
			? 'Right'
			: !answered
				? 'Not answered'
				: pairs && pairs.right / pairs.total >= 0.8
					? 'Nearly'
					: 'Not quite'
	return (
		<div className="grid gap-3 rounded-2xl border border-world-line bg-world-card p-4" data-testid="result">
			<p className={`font-sans text-sm font-semibold ${result.correct ? 'text-path' : 'text-red'}`}>{verdict}</p>
			{prompt && <p className="text-lg leading-snug">{prompt}</p>}
			{order && (
				<div className="grid gap-2">
					{pairs && !result.correct && (
						<p className="font-sans text-sm text-world-muted">
							{pairs.right} of {pairs.total} pairs of steps in the right order
						</p>
					)}
					<p className="font-sans text-xs font-semibold tracking-wide text-world-muted uppercase">Right order</p>
					<ol className="grid gap-2" aria-label="Right order">
						{order.steps.map((step, i) => {
							const mine = order.given ? order.given.indexOf(i) : -1
							return (
								<li key={i} className={`flex items-start gap-3 rounded-xl border p-3 ${mine < 0 || mine === i ? 'border-world-line' : 'border-red'}`}>
									<span className="mt-0.5 w-5 shrink-0 font-sans text-sm font-semibold text-world-muted">{i + 1}</span>
									<span className="grow">{step}</span>
									{mine >= 0 && mine !== i && <span className="shrink-0 font-sans text-xs font-semibold text-red">You put it {ordinal(mine + 1)}</span>}
								</li>
							)
						})}
					</ol>
				</div>
			)}
			{given !== null && !choice && !exact && !order && <p className="whitespace-pre-wrap text-world-muted">You wrote: {given}</p>}
			{exact && (
				<dl className="grid gap-2 sm:grid-cols-2">
					<div className="grid gap-1 rounded-xl border border-path p-3">
						<dt className="font-sans text-xs font-semibold tracking-wide text-world-muted uppercase">Right answer</dt>
						<dd className={`whitespace-pre-wrap ${mono}`}>{exact.expected}</dd>
					</div>
					{exact.given !== null && (
						<div className={`grid gap-1 rounded-xl border p-3 ${result.correct ? 'border-path' : 'border-red'}`}>
							<dt className="font-sans text-xs font-semibold tracking-wide text-world-muted uppercase">You wrote</dt>
							<dd className={`whitespace-pre-wrap ${mono}`}>{exact.given}</dd>
						</div>
					)}
				</dl>
			)}
			{choice?.guess && <p className="whitespace-pre-wrap text-world-muted">You guessed: {choice.guess}</p>}
			{choice && (
				<ul className="grid gap-2" aria-label="Options">
					{choice.options.map((option, i) => {
						const right = i === choice.right
						const mine = i === choice.picked
						return (
							<li key={i} className={`grid gap-0.5 rounded-xl border p-3 ${right ? 'border-path' : mine ? 'border-red' : 'border-world-line'}`}>
								<p className="flex flex-wrap items-baseline gap-x-2">
									<span className="font-sans text-sm font-semibold text-world-muted">{LETTERS[i]}</span>
									<span>{option}</span>
									{right && <span className="font-sans text-xs font-semibold text-path">Right answer</span>}
									{mine && !right && <span className="font-sans text-xs font-semibold text-red">Your pick</span>}
								</p>
								{!right && choice.whyWrong[i] && <p className="font-sans text-sm text-world-muted">{choice.whyWrong[i]}</p>}
							</li>
						)
					})}
				</ul>
			)}
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
					<span className="font-sans text-xs font-semibold tracking-wide text-world-muted uppercase">{choice ? 'Why ' : order ? 'Why this order ' : exact?.kind === 'number' ? 'Worked solution ' : exact ? 'Why it prints that ' : 'Model answer '}</span>
					{reveal.reference}
				</p>
			)}
			{reveal.quote && <p className="text-sm text-world-muted italic">From the text: “{reveal.quote}”</p>}
			{showDue && <p className="font-sans text-xs text-world-muted">{backIn(result.dueAt)}</p>}
			{/* A choice is checked against its key, so there is nothing to count again; a wrong key is reported instead. */}
			{answerId && given !== null && !choice && !order && !result.correct && (
				<div>
					<button type="button" className={quiet} disabled={override.isPending} onClick={() => override.mutate(answerId)}>
						Count it as right
					</button>
				</div>
			)}
			<ErrorText>{override.error && errorMessage(override.error)}</ErrorText>
		</div>
	)
}
