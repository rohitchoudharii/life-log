import Ionicons from '@expo/vector-icons/Ionicons'
import type { PointStatus, QuestionType } from '@peak/core'
import { useQueryClient } from '@tanstack/react-query'
import { useState, type ComponentType, type ReactNode } from 'react'
import { ActivityIndicator, Pressable, TextInput } from 'react-native'
import { api, type AnswerResult, type Question } from './api'
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

const shortAnswer: QuestionView<'short_answer'> = {
	label: 'Explain it',
	skip: { skipped: true },
	Input({ response, onChange }) {
		const c = useColors()
		const answer = (response as { answer?: string } | null)?.answer ?? ''
		return (
			<Group gap={space.sm}>
				<Text variant="muted">Answer from memory, in your own words. You see how you did at the end.</Text>
				<TextInput
					value={answer}
					onChangeText={(text) => onChange(text.trim() ? { answer: text } : null)}
					placeholder="Type your answer"
					placeholderTextColor={c.sub}
					multiline
					textAlignVertical="top"
					style={{
						minHeight: 140,
						fontFamily: font.regular,
						fontSize: 16,
						lineHeight: 24,
						color: c.fg,
						borderWidth: hairline,
						borderColor: c.ring,
						outlineColor: c.fg,
						borderRadius: radius,
						padding: space.md,
					}}
				/>
			</Group>
		)
	},
	Review({ response, result }) {
		const reveal = result.reveal as {
			reference?: string
			score?: number
			feedback?: string
			mustHave?: string[]
			points?: PointStatus[]
			misconception?: string | null
		}
		const skipped = 'skipped' in (response as object)
		const points = reveal.mustHave ?? []
		return (
			<Group gap={space.md}>
				<Mark ok={result.correct} label={skipped ? "You didn't know this one" : verdictLabel(reveal.score ?? 0)} />
				{!skipped && (
					<Group gap={2}>
						<Text variant="label">Your answer</Text>
						<Text selectable>{(response as { answer: string }).answer.trim()}</Text>
					</Group>
				)}
				{reveal.misconception ? <Text>Misconception: {reveal.misconception}</Text> : null}
				{reveal.feedback ? <Text>{reveal.feedback}</Text> : null}
				{points.length ? (
					<Group gap={space.xs}>
						<Text variant="label">A full answer makes these points</Text>
						{points.map((p, i) => (
							<PointRow key={i} text={p} status={skipped ? 'missing' : reveal.points?.[i]} />
						))}
					</Group>
				) : null}
				<Group gap={2}>
					<Text variant="label">Model answer</Text>
					<Text selectable>{reveal.reference}</Text>
				</Group>
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

/** One view per question type. Adding a type in @peak/core means adding its view here. */
const views: { [K in QuestionType]: QuestionView<K> } = { short_answer: shortAnswer, mcq }
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
					<Text variant="muted">Next review: {nextReviewLabel(graded.result.dueAt)}</Text>
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
}: {
	title: string
	questions: Question[]
	onDone(): void
	doneLabel?: string
	/** Shown on the results screen above the answers, such as how the brain dump went. */
	before?: ReactNode
}) {
	const queryClient = useQueryClient()
	// Responses stay editable (Previous) until Finish; only then are they sent for grading.
	const [responses, setResponses] = useState<unknown[]>(() => questions.map(() => null))
	const [index, setIndex] = useState(0)
	const [entries, setEntries] = useState<Entry[] | null>(null)
	const current = questions[index]!
	const last = index + 1 === questions.length

	const grade = (i: number, question: Question, response: unknown) => {
		const set = (graded: Graded) => setEntries((es) => es && es.map((e, j) => (j === i ? { ...e, graded } : e)))
		set({ status: 'checking' })
		api
			.answer(question.id, response)
			.then((result) => set({ status: 'done', result }))
			.catch((error) => set({ status: 'error', error }))
			.finally(() => {
				queryClient.invalidateQueries({ queryKey: ['today'] })
				queryClient.invalidateQueries({ queryKey: ['due'] })
			})
	}

	const finish = (all: unknown[]) => {
		setEntries(questions.map((question, i) => ({ question, response: all[i], graded: { status: 'checking' } })))
		questions.forEach((q, i) => grade(i, q, all[i]))
	}

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
		return (
			<Screen footer={<Button title={doneLabel} onPress={onDone} />}>
				<Group>
					<Text variant="muted">{title}</Text>
					<Text variant="title">
						{checking ? `Checking ${checking} answer${checking === 1 ? '' : 's'}…` : `You recalled ${recalled} of ${entries.length - failed}`}
					</Text>
					{!checking && (
						<Text variant="muted">
							{failed
								? `${failed} could not be checked. Try them again below.`
								: recalled === entries.length - failed
									? 'Every card is spaced further out now.'
									: 'Missed cards come back in about 10 minutes, then again tomorrow. Missing is how recall gets stronger.'}
						</Text>
					)}
				</Group>
				{before}
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
						{current.itemTitle ?? title}
					</Text>
					<Text variant="muted">
						{index + 1} of {questions.length}
					</Text>
				</Row>
				<Progress value={index / questions.length} />
			</Group>
			<Group gap={space.xl}>
				<Group gap={space.md}>
					<Pill>{view.label}</Pill>
					<Text variant="question">{current.prompt.prompt}</Text>
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
