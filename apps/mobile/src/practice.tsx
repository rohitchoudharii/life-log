import Ionicons from '@expo/vector-icons/Ionicons'
import type { AnswerMark, PointStatus, QuestionType } from '@life-log-club/core'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, type ComponentType, type ReactNode } from 'react'
import { ActivityIndicator, Platform, Pressable, TextInput, View, type TextInputProps } from 'react-native'
import { api, type AnswerResult, type Question } from './api'
import { CodeBlock, mono } from './blocks'
import { font, hairline, radius, space, useColors } from './theme'
import { Button, ErrorText, Group, Pill, Progress, Row, Screen, Text, Tile } from './ui'

export function nextReviewLabel(dueAt: string) {
	const ms = new Date(dueAt).getTime() - Date.now()
	if (ms < 60 * 60 * 1000) return `In ${Math.max(1, Math.round(ms / 60_000))} minutes`
	const days = Math.round(ms / 86_400_000)
	if (days <= 1) return 'Tomorrow'
	return `In ${days} days`
}

type Of<K extends QuestionType> = Extract<Question, { type: K }>
/** While answering: the question and the user's draft response, null until it can be submitted. */
type InputProps<Q extends Question> = { question: Q; response: unknown; onChange(response: unknown): void }
/** On the results screen: what they answered and how it was graded. */
type ReviewProps<Q extends Question> = { question: Q; response: unknown; result: AnswerResult }

type QuestionView<K extends QuestionType> = {
	label: string
	Input: ComponentType<InputProps<Of<K>>>
	Review: ComponentType<ReviewProps<Of<K>>>
	/** The response "I don't know" sends, for types that allow it. */
	skip?: unknown
	/** Move to the next question as soon as a response is picked, as for multiple choice. */
	advanceOnPick?: boolean
}

function Mark({ ok, label }: { ok: boolean; label: string }) {
	const c = useColors()
	return (
		<Row style={{ justifyContent: 'flex-start', gap: space.xs }}>
			<Ionicons name={ok ? 'checkmark' : 'close'} size={16} color={c.fg} />
			<Text style={{ fontFamily: font.medium }}>{label}</Text>
		</Row>
	)
}

const verdictLabel = (score: number) =>
	score >= 4 ? 'Correct' : score === 3 ? 'Right, with a small gap' : score === 2 ? 'Partly right' : 'Not quite'

const POINT_ICON = { covered: 'checkmark', vague: 'remove', missing: 'close' } as const
const POINT_LABEL = { covered: 'You made this point', vague: 'Vague', missing: 'Missing' } as const

export function PointRow({ text, status }: { text: string; status?: PointStatus }) {
	const c = useColors()
	return (
		<Row style={{ justifyContent: 'flex-start', alignItems: 'flex-start', gap: space.sm }}>
			<Ionicons
				name={status ? POINT_ICON[status] : 'ellipse-outline'}
				size={16}
				color={status === 'covered' ? c.fg : c.sub}
				accessibilityLabel={status ? POINT_LABEL[status] : undefined}
				style={{ marginTop: 3 }}
			/>
			<Text style={{ flex: 1, color: status === 'covered' ? c.fg : c.sub }}>{text}</Text>
		</Row>
	)
}

/** A text box that grows with what is typed, from `lines` lines up, so nothing scrolls out of sight. */
function Field({ mono: monospace, lines = 1, style, ...props }: TextInputProps & { mono?: boolean; lines?: number }) {
	const c = useColors()
	const lineHeight = monospace ? 22 : 24
	const typed = String(props.value ?? '').split('\n').length
	return (
		<TextInput
			placeholderTextColor={c.sub}
			textAlignVertical="top"
			autoCapitalize={monospace ? 'none' : undefined}
			autoCorrect={monospace ? false : undefined}
			spellCheck={monospace ? false : undefined}
			{...props}
			style={[
				{
					minHeight: Math.max(lines, props.multiline ? typed + 1 : 1) * lineHeight + space.md * 2 + hairline * 2,
					fontFamily: monospace ? mono : font.regular,
					fontSize: monospace ? 14 : 16,
					lineHeight,
					color: c.fg,
					borderWidth: hairline,
					borderColor: c.ring,
					outlineColor: c.fg,
					borderRadius: radius,
					padding: space.md,
				},
				style,
			]}
		/>
	)
}

type WrittenReveal = {
	reference?: string
	score?: number
	feedback?: string
	mustHave?: string[]
	points?: PointStatus[]
	misconception?: string | null
	marks?: AnswerMark[]
}

function Labeled({ label, children }: { label: string; children: ReactNode }) {
	return (
		<Group gap={2}>
			<Text variant="label">{label}</Text>
			{children}
		</Group>
	)
}

/** Splits the answer around the judge's quotes, first occurrence each, skipping any that overlap an earlier one. */
function markedRuns(text: string, marks: AnswerMark[]) {
	const found = marks
		.map((m) => ({ ...m, start: text.indexOf(m.quote) }))
		.filter((m) => m.start >= 0)
		.sort((a, b) => a.start - b.start)
	const runs: { text: string; right?: boolean }[] = []
	let at = 0
	for (const m of found) {
		if (m.start < at) continue
		if (m.start > at) runs.push({ text: text.slice(at, m.start) })
		runs.push({ text: m.quote, right: m.right })
		at = m.start + m.quote.length
	}
	if (at < text.length) runs.push({ text: text.slice(at) })
	return runs
}

/** The learner's answer in a box like the one they typed it into, with right phrases underlined and wrong ones struck through. */
function MarkedAnswer({ text, marks = [] }: { text: string; marks?: AnswerMark[] }) {
	const c = useColors()
	const runs = markedRuns(text, marks)
	const hasRight = runs.some((r) => r.right === true)
	const hasWrong = runs.some((r) => r.right === false)
	return (
		<Labeled label="Your answer">
			<View style={{ borderWidth: hairline, borderColor: c.ring, borderRadius: radius, padding: space.md, marginTop: space.xs }}>
				<Text selectable>
					{runs.map((r, i) =>
						r.right === undefined ? (
							r.text
						) : (
							<Text
								key={i}
								style={
									r.right
										? { textDecorationLine: 'underline', textDecorationColor: c.fg }
										: { textDecorationLine: 'line-through', color: c.sub }
								}
							>
								{r.text}
							</Text>
						),
					)}
				</Text>
			</View>
			{hasRight || hasWrong ? (
				<Text variant="muted" style={{ marginTop: space.xs }}>
					{[hasRight && 'Underlined: right', hasWrong && 'Struck through: wrong'].filter(Boolean).join('. ')}
				</Text>
			) : null}
		</Labeled>
	)
}

/** Feedback and the must-have points, as the judge marked them. */
function Checklist({ reveal, skipped, heading }: { reveal: WrittenReveal; skipped: boolean; heading: string }) {
	const points = reveal.mustHave ?? []
	return (
		<>
			{reveal.feedback || reveal.misconception ? (
				<Labeled label="Feedback">
					{reveal.misconception ? <Text>Misconception: {reveal.misconception}</Text> : null}
					{reveal.feedback ? <Text>{reveal.feedback}</Text> : null}
				</Labeled>
			) : null}
			{points.length ? (
				<Group gap={space.xs}>
					<Text variant="label">{heading}</Text>
					{points.map((p, i) => (
						<PointRow key={i} text={p} status={skipped ? 'missing' : reveal.points?.[i]} />
					))}
				</Group>
			) : null}
		</>
	)
}

/** A question answered in writing and graded against must-have points: explain it, or find the error. */
const writtenView = <K extends 'short_answer' | 'find_error'>(label: string, hint: string): QuestionView<K> => ({
	label,
	skip: { skipped: true },
	Input({ response, onChange }) {
		const answer = (response as { answer?: string } | null)?.answer ?? ''
		return (
			<Group gap={space.sm}>
				<Text variant="muted">{hint}</Text>
				<Field value={answer} onChangeText={(text) => onChange(text.trim() ? { answer: text } : null)} placeholder="Type your answer" multiline lines={5} />
			</Group>
		)
	},
	Review({ response, result }) {
		const reveal = result.reveal as WrittenReveal
		const skipped = 'skipped' in (response as object)
		return (
			<Group gap={space.md}>
				<Mark ok={result.correct} label={skipped ? "You didn't know this one" : verdictLabel(reveal.score ?? 0)} />
				{!skipped && <MarkedAnswer text={(response as { answer: string }).answer.trim()} marks={reveal.marks} />}
				<Checklist reveal={reveal} skipped={skipped} heading="Important points" />
				<Labeled label="Model answer">
					<Text selectable>{reveal.reference}</Text>
				</Labeled>
			</Group>
		)
	},
})

const shortAnswer = writtenView<'short_answer'>('Explain it', 'Answer from memory, in your own words. You see how you did at the end.')
const findError = writtenView<'find_error'>('Find the error', 'Say what is wrong and why. You see how you did at the end.')

const workedProblem: QuestionView<'worked_problem'> = {
	label: 'Work it out',
	skip: { skipped: true },
	Input({ question, response, onChange }) {
		const r = (response as { value?: string; working?: string } | null) ?? {}
		const [working, setWorking] = useState(r.working ?? '')
		const [value, setValue] = useState(r.value ?? '')
		const send = (v: string, w: string) => onChange(v.trim() ? { value: v, ...(w.trim() ? { working: w } : {}) } : null)
		const unit = question.prompt.unit
		return (
			<Group gap={space.md}>
				<Text variant="muted">Work it out without the text. The number is checked exactly; your working, if you write it, shows where you went wrong.</Text>
				<Group gap={space.xs}>
					<Text variant="label">Working (optional)</Text>
					<Field
						value={working}
						onChangeText={(w) => (setWorking(w), send(value, w))}
						placeholder="Your steps"
						multiline
						lines={3}
					/>
				</Group>
				<Group gap={space.xs}>
					<Text variant="label">Answer</Text>
					<Row style={{ gap: space.sm }}>
						<Field
							value={value}
							onChangeText={(v) => (setValue(v), send(v, working))}
							placeholder="A number"
							accessibilityLabel="Answer"
							keyboardType={Platform.OS === 'ios' ? 'numbers-and-punctuation' : 'default'}
							style={{ flex: 1 }}
						/>
						{unit ? <Text>{unit}</Text> : null}
					</Row>
				</Group>
			</Group>
		)
	},
	Review({ response, result }) {
		const reveal = result.reveal as { answer: number; unit?: string; solution: string; steps?: string[]; given?: number | null } & WrittenReveal
		const skipped = 'skipped' in (response as object)
		const r = response as { value?: string; working?: string }
		const unit = reveal.unit ? ` ${reveal.unit}` : ''
		return (
			<Group gap={space.md}>
				<Mark ok={result.correct} label={skipped ? "You didn't know this one" : result.correct ? 'Correct' : 'Not quite'} />
				{!skipped && (
					<Labeled label="Your answer">
						<Text selectable>
							{r.value?.trim()}
							{reveal.given === null ? ' (not read as a number)' : ''}
						</Text>
					</Labeled>
				)}
				<Labeled label="Right answer">
					<Text selectable>
						{reveal.answer}
						{unit}
					</Text>
				</Labeled>
				{r.working ? <Checklist reveal={{ ...reveal, mustHave: reveal.steps }} skipped={false} heading="Key steps" /> : null}
				<Labeled label="Solution">
					<Text selectable>{reveal.solution}</Text>
				</Labeled>
			</Group>
		)
	},
}

const predictOutput: QuestionView<'predict_output'> = {
	label: 'Predict the output',
	skip: { skipped: true },
	Input({ response, onChange }) {
		const output = (response as { output?: string } | null)?.output ?? ''
		return (
			<Group gap={space.sm}>
				<Text variant="muted">Run it in your head and write exactly what it prints, one line per printed line.</Text>
				<Field
					mono
					value={output}
					onChangeText={(text) => onChange(text.trim() ? { output: text } : null)}
					placeholder="Output"
					accessibilityLabel="Output"
					multiline
					lines={3}
				/>
			</Group>
		)
	},
	Review({ response, result }) {
		const reveal = result.reveal as { output: string; explanation?: string }
		const skipped = 'skipped' in (response as object)
		return (
			<Group gap={space.md}>
				<Mark ok={result.correct} label={skipped ? "You didn't know this one" : result.correct ? 'Correct' : 'Not quite'} />
				{!skipped && (
					<Labeled label="You said it prints">
						<CodeBlock code={(response as { output: string }).output.replace(/\n+$/, '')} wrap />
					</Labeled>
				)}
				<Labeled label="It prints">
					<CodeBlock code={reveal.output} wrap />
				</Labeled>
				{reveal.explanation ? <Text>{reveal.explanation}</Text> : null}
			</Group>
		)
	},
}

function StepRow({ n, text, onUp, onDown, mark }: { n: number; text: string; onUp?: () => void; onDown?: () => void; mark?: boolean }) {
	const c = useColors()
	const arrow = (icon: 'chevron-up' | 'chevron-down', onPress: (() => void) | undefined, a11y: string) => (
		<Pressable
			accessibilityRole="button"
			accessibilityLabel={a11y}
			disabled={!onPress}
			onPress={onPress}
			hitSlop={4}
			style={({ pressed }) => ({ width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: radius, opacity: onPress ? 1 : 0.25, backgroundColor: pressed ? c.track : 'transparent' })}
		>
			<Ionicons name={icon} size={18} color={c.fg} />
		</Pressable>
	)
	const editable = onUp !== undefined || onDown !== undefined
	return (
		<View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 48, paddingLeft: space.lg, paddingRight: editable ? space.xs : space.lg, paddingVertical: space.xs, borderRadius: radius, borderWidth: hairline, borderColor: c.ring }}>
			<Text style={{ fontFamily: font.medium, minWidth: 18, fontVariant: ['tabular-nums'] }}>{n}</Text>
			<Text style={{ flex: 1 }}>{text}</Text>
			{mark !== undefined && <Ionicons name={mark ? 'checkmark' : 'close'} size={16} color={mark ? c.fg : c.sub} accessibilityLabel={mark ? 'In the right place' : 'Out of place'} />}
			{editable && (
				<>
					{arrow('chevron-up', onUp, `Move "${text}" up`)}
					{arrow('chevron-down', onDown, `Move "${text}" down`)}
				</>
			)}
		</View>
	)
}

const orderSteps: QuestionView<'order_steps'> = {
	label: 'Order the steps',
	Input({ question, response, onChange }) {
		const steps = question.prompt.steps
		const [order, setOrder] = useState<number[]>((response as { order?: number[] } | null)?.order ?? steps.map((_, i) => i))
		const move = (from: number, to: number) => {
			const next = [...order]
			;[next[from], next[to]] = [next[to]!, next[from]!]
			setOrder(next)
			onChange({ order: next })
		}
		return (
			<Group gap={space.sm}>
				<Text variant="muted">Move each step into place, first at the top.</Text>
				{order.map((k, i) => (
					<StepRow key={k} n={i + 1} text={steps[k]!} onUp={i > 0 ? () => move(i, i - 1) : undefined} onDown={i < order.length - 1 ? () => move(i, i + 1) : undefined} />
				))}
				{response === null && <Button title="This order is right" kind="outline" onPress={() => onChange({ order })} />}
			</Group>
		)
	},
	Review({ question, response, result }) {
		const reveal = result.reveal as { steps: string[]; explanation?: string; pairs?: number }
		const mine = (response as { order: number[] }).order.map((k) => question.prompt.steps[k]!)
		return (
			<Group gap={space.md}>
				<Mark ok={result.correct} label={result.correct ? 'Correct' : result.rating === 'hard' ? 'Close: a step or two out of place' : 'Not quite'} />
				{!result.correct && (
					<Group gap={space.xs}>
						<Text variant="label">Your order</Text>
						{mine.map((text, i) => (
							<StepRow key={i} n={i + 1} text={text} mark={reveal.steps[i] === text} />
						))}
					</Group>
				)}
				<Group gap={space.xs}>
					<Text variant="label">Right order</Text>
					{reveal.steps.map((text, i) => (
						<StepRow key={i} n={i + 1} text={text} />
					))}
				</Group>
				{reveal.explanation ? <Text>{reveal.explanation}</Text> : null}
			</Group>
		)
	},
}

function McqOption({ text, selected, onPress, mark }: { text: string; selected: boolean; onPress?: () => void; mark?: 'right' | 'wrong' }) {
	const c = useColors()
	return (
		<Pressable
			accessibilityRole="radio"
			accessibilityState={{ selected }}
			disabled={!onPress}
			onPress={onPress}
			style={({ pressed }) => ({
				flexDirection: 'row',
				alignItems: 'center',
				gap: space.sm,
				minHeight: 48,
				paddingVertical: space.md,
				paddingHorizontal: space.lg,
				borderRadius: radius,
				borderWidth: selected || mark === 'right' ? 2 : hairline,
				borderColor: selected || pressed || mark ? c.fg : c.ring,
			})}
		>
			<Text style={{ flex: 1 }}>{text}</Text>
			{mark && (
				<Ionicons
					name={mark === 'right' ? 'checkmark' : 'close'}
					size={18}
					color={c.fg}
					accessibilityLabel={mark === 'right' ? 'Correct answer' : 'Your answer'}
				/>
			)}
		</Pressable>
	)
}

const mcq: QuestionView<'mcq'> = {
	label: 'Multiple choice',
	advanceOnPick: true,
	Input({ question, response, onChange }) {
		const choice = (response as { choice?: number } | null)?.choice
		// Recall first, then choose: the options stay hidden until the learner has tried to answer in their head.
		const [shown, setShown] = useState(choice !== undefined)
		if (!shown)
			return (
				<Group gap={space.md}>
					<Text variant="muted">Think of the answer before you look at the options.</Text>
					<Button title="Show options" kind="outline" onPress={() => setShown(true)} />
				</Group>
			)
		return (
			<Group gap={space.sm}>
				{question.prompt.options.map((option, i) => (
					<McqOption key={i} text={option} selected={choice === i} onPress={() => onChange({ choice: i })} />
				))}
			</Group>
		)
	},
	Review({ question, response, result }) {
		const { answerIndex, explanation, whyWrong } = result.reveal as { answerIndex: number; explanation?: string; whyWrong?: string }
		const choice = (response as { choice: number }).choice
		return (
			<Group gap={space.md}>
				<Mark ok={result.correct} label={result.correct ? 'Correct' : 'Not quite'} />
				<Group gap={space.xs}>
					{question.prompt.options.map((option, i) => (
						<McqOption
							key={i}
							text={option}
							selected={false}
							mark={i === answerIndex ? 'right' : i === choice ? 'wrong' : undefined}
						/>
					))}
				</Group>
				{!result.correct && whyWrong ? <Text>Why your pick is wrong: {whyWrong}</Text> : null}
				{explanation ? <Text>{explanation}</Text> : null}
			</Group>
		)
	},
}

/** One view per question type. Adding a type in @life-log-club/core means adding its view here. */
type WordReveal = { word: string; sentence: string; meaning: string } & WrittenReveal

/** The sentence a word was met in, set off like a quote. */
function Sentence({ text }: { text: string }) {
	const c = useColors()
	return (
		<View style={{ paddingLeft: space.md, borderLeftWidth: 2, borderColor: c.ring }}>
			<Text selectable style={{ fontSize: 17, lineHeight: 27 }}>
				{text}
			</Text>
		</View>
	)
}

/** A vocabulary test: the sentence, a written answer, and the word with its meaning afterwards. */
const wordView = <K extends 'word_cloze' | 'word_meaning' | 'word_use'>(label: string, placeholder: string, judged: boolean): QuestionView<K> => ({
	label,
	skip: { skipped: true },
	Input({ question, response, onChange }) {
		const p = (question as Question).prompt as unknown as { sentence: string; hint?: string }
		const answer = (response as { answer?: string } | null)?.answer ?? ''
		return (
			<Group gap={space.md}>
				<Sentence text={p.sentence} />
				{p.hint ? <Text variant="muted">{p.hint}</Text> : null}
				<Field
					value={answer}
					onChangeText={(text) => onChange(text.trim() ? { answer: text } : null)}
					placeholder={placeholder}
					accessibilityLabel="Your answer"
					autoCapitalize="none"
					multiline={judged}
					lines={judged ? 3 : 1}
				/>
			</Group>
		)
	},
	Review({ response, result }) {
		const reveal = result.reveal as WordReveal
		const skipped = 'skipped' in (response as object)
		return (
			<Group gap={space.md}>
				<Mark ok={result.correct} label={skipped ? "You didn't know this one" : judged ? verdictLabel(reveal.score ?? 0) : result.correct ? 'Correct' : 'Not quite'} />
				{!skipped && (
					<Labeled label="Your answer">
						<Text selectable>{(response as { answer: string }).answer.trim()}</Text>
					</Labeled>
				)}
				{judged && reveal.feedback ? <Text>{reveal.feedback}</Text> : null}
				<Labeled label={reveal.word}>
					<Text selectable>{reveal.meaning}</Text>
				</Labeled>
				<Sentence text={reveal.sentence} />
			</Group>
		)
	},
})

const views: { [K in QuestionType]: QuestionView<K> } = {
	word_cloze: wordView<'word_cloze'>('Fill the word', 'The missing word', false),
	word_meaning: wordView<'word_meaning'>('What it means', 'What the word means here', true),
	word_use: wordView<'word_use'>('Use it', 'Your own sentence', true),
	short_answer: shortAnswer,
	mcq,
	worked_problem: workedProblem,
	predict_output: predictOutput,
	find_error: findError,
	order_steps: orderSteps,
}
const viewFor = (q: Question) => views[q.type] as unknown as QuestionView<QuestionType> & {
	Input: ComponentType<InputProps<Question>>
	Review: ComponentType<ReviewProps<Question>>
}

type Graded = { status: 'checking' } | { status: 'done'; result: AnswerResult } | { status: 'error'; error: unknown }
type Entry = { question: Question; response: unknown; graded: Graded }

function ResultTile({ entry, index, onRetry }: { entry: Entry; index: number; onRetry(): void }) {
	const c = useColors()
	const { question, response, graded } = entry
	const view = viewFor(question)
	return (
		<Tile style={{ gap: space.md, paddingVertical: space.lg }}>
			<Row>
				<Pill>{view.label}</Pill>
				<Text variant="muted">{index + 1}</Text>
			</Row>
			<Text style={{ fontFamily: font.semibold }}>{question.prompt.prompt}</Text>
			{'code' in question.prompt && question.prompt.code ? <CodeBlock code={question.prompt.code} wrap /> : null}
			{graded.status === 'checking' && (
				<Row style={{ justifyContent: 'flex-start' }}>
					<ActivityIndicator color={c.fg} size="small" />
					<Text variant="muted">Checking your answer…</Text>
				</Row>
			)}
			{graded.status === 'error' && (
				<Group gap={space.sm}>
					{response && typeof response === 'object' && 'answer' in response ? (
						<Group gap={2}>
							<Text variant="label">Your answer</Text>
							<Text selectable>{String(response.answer).trim()}</Text>
						</Group>
					) : null}
					<ErrorText error={graded.error} />
					<Button title="Try again" kind="outline" onPress={onRetry} />
				</Group>
			)}
			{graded.status === 'done' && (
				<>
					<view.Review question={question} response={response} result={graded.result} />
					{graded.result.practice ? (
						<Text variant="muted">Practice: when this idea comes back is unchanged.</Text>
					) : graded.result.dueAt ? (
						<Text variant="muted">Next review: {nextReviewLabel(graded.result.dueAt)}</Text>
					) : null}
				</>
			)}
		</Tile>
	)
}

/**
 * Runs a test over a list of questions. Answers are sent as the user goes, but nothing is
 * revealed until the end, so earlier answers cannot hint at later ones.
 */
export function PracticeSession({
	title,
	questions,
	onDone,
	doneLabel = 'Done',
	before,
	submit = api.answer,
}: {
	title: string
	questions: Question[]
	/** Where answers are sent; vocabulary has its own endpoint. */
	submit?: (id: string, response: unknown, practice: boolean) => Promise<AnswerResult>
	onDone(): void
	doneLabel?: string
	/** Shown on the results screen above the answers, such as how the brain dump went. */
	before?: ReactNode
}) {
	const queryClient = useQueryClient()
	// The first round moves schedules; retry rounds after it are practice on the ideas just missed.
	const [round, setRound] = useState({ questions, practice: false, number: 0 })
	// Responses stay editable (Previous) until Finish; only then are they sent for grading.
	const [responses, setResponses] = useState<unknown[]>(() => questions.map(() => null))
	const [index, setIndex] = useState(0)
	const [entries, setEntries] = useState<Entry[] | null>(null)
	/** Every question asked in this sitting, so a retry asks something new. */
	const [asked, setAsked] = useState<string[]>(() => questions.map((q) => q.id))
	const current = round.questions[index]!
	const last = index + 1 === round.questions.length

	const grade = (i: number, question: Question, response: unknown) => {
		const set = (graded: Graded) => setEntries((es) => es && es.map((e, j) => (j === i ? { ...e, graded } : e)))
		set({ status: 'checking' })
		submit(question.id, response, round.practice)
			.then((result) => set({ status: 'done', result }))
			.catch((error) => set({ status: 'error', error }))
			.finally(() => {
				queryClient.invalidateQueries({ queryKey: ['today'] })
				queryClient.invalidateQueries({ queryKey: ['due'] })
				queryClient.invalidateQueries({ queryKey: ['items'] })
				queryClient.invalidateQueries({ queryKey: ['words'] })
			})
	}

	const finish = (all: unknown[]) => {
		setEntries(round.questions.map((question, i) => ({ question, response: all[i], graded: { status: 'checking' } })))
		round.questions.forEach((q, i) => grade(i, q, all[i]))
	}

	const retry = useMutation({
		mutationFn: (ideaIds: string[]) => api.retry(ideaIds, asked),
		onSuccess: ({ questions: next }) => {
			if (!next.length) return
			setAsked((a) => [...a, ...next.map((q) => q.id)])
			setRound((r) => ({ questions: next, practice: true, number: r.number + 1 }))
			setResponses(next.map(() => null))
			setIndex(0)
			setEntries(null)
		},
	})

	/** Records the response for the current question, then moves on when asked to. */
	const answer = (response: unknown, advance: boolean) => {
		const next = responses.map((r, i) => (i === index ? response : r))
		setResponses(next)
		if (!advance || response === null) return
		if (last) finish(next)
		// A short pause lets the picked option show before the next question replaces it.
		else setTimeout(() => setIndex((i) => (i === index ? i + 1 : i)), 250)
	}

	if (entries) {
		const checking = entries.filter((e) => e.graded.status === 'checking').length
		const failed = entries.filter((e) => e.graded.status === 'error').length
		const recalled = entries.filter((e) => e.graded.status === 'done' && e.graded.result.correct).length
		const missedIdeas = [
			...new Set(entries.flatMap((e) => (e.graded.status === 'done' && !e.graded.result.correct && e.question.ideaId ? [e.question.ideaId] : []))),
		]
		const heading = round.practice ? `Retry round${round.number > 1 ? ` ${round.number}` : ''}` : title
		return (
			<Screen
				footer={
					<Group gap={space.sm}>
						{!checking && missedIdeas.length > 0 && (
							<Button
								title={`Retry ${missedIdeas.length} missed idea${missedIdeas.length === 1 ? '' : 's'}`}
								kind="outline"
								loading={retry.isPending}
								onPress={() => retry.mutate(missedIdeas)}
							/>
						)}
						<Button title={doneLabel} onPress={onDone} />
					</Group>
				}
			>
				<Group>
					<Text variant="muted">{heading}</Text>
					<Text variant="title">
						{checking ? `Checking ${checking} answer${checking === 1 ? '' : 's'}…` : `You recalled ${recalled} of ${entries.length - failed}`}
					</Text>
					{!checking && (
						<Text variant="muted">
							{failed
								? `${failed} could not be checked. Try them again below.`
								: round.practice
									? recalled === entries.length
										? 'Every missed idea came back. Practice answers do not change when ideas are due.'
										: 'Practice answers do not change when ideas are due. Retry again until each one comes back.'
									: recalled === entries.length - failed
										? 'Every idea is spaced further out now.'
										: 'Missed ideas come back in about 10 minutes, with an easier question. Retry them now with new questions: missing is how recall gets stronger.'}
						</Text>
					)}
				</Group>
				<ErrorText error={retry.error} />
				{retry.data && !retry.data.questions.length ? <Text variant="muted">No other questions on these ideas yet. Connect your AI in Settings to get new ones.</Text> : null}
				{!round.practice && before}
				<Group gap={space.md}>
					{entries.map((e, i) => (
						<ResultTile key={i} entry={e} index={i} onRetry={() => grade(i, e.question, e.response)} />
					))}
				</Group>
			</Screen>
		)
	}

	const view = viewFor(current)
	const response = responses[index]
	return (
		<Screen
			footer={
				<Group gap={space.sm}>
					<Row style={{ gap: space.sm }}>
						<Button title="Previous" kind="outline" onPress={() => setIndex(index - 1)} disabled={index === 0} style={{ flex: 1 }} />
						<Button
							title={last ? 'Finish' : 'Next'}
							onPress={() => (last ? finish(responses) : setIndex(index + 1))}
							disabled={response === null}
							style={{ flex: 1 }}
						/>
					</Row>
					{view.skip !== undefined && <Button title="I don't know" kind="outline" onPress={() => answer(view.skip, true)} />}
				</Group>
			}
		>
			<Group>
				<Row>
					<Text variant="muted" style={{ flex: 1 }} numberOfLines={1}>
						{round.practice ? 'Retry round' : (current.itemTitle ?? title)}
					</Text>
					<Text variant="muted">
						{index + 1} of {round.questions.length}
					</Text>
				</Row>
				<Progress value={index / round.questions.length} />
			</Group>
			<Group gap={space.xl}>
				<Group gap={space.md}>
					<Pill>{view.label}</Pill>
					<Text variant="question">{current.prompt.prompt}</Text>
					{'code' in current.prompt && current.prompt.code ? <CodeBlock code={current.prompt.code} wrap /> : null}
				</Group>
				<view.Input
					key={current.id + index}
					question={current}
					response={response}
					onChange={(r) => answer(r, Boolean(view.advanceOnPick) && !last)}
				/>
			</Group>
		</Screen>
	)
}
