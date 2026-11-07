import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useState } from 'react'
import { api, type Question, type Recall } from '@/api'
import { PracticeSession } from '@/practice'
import { BrainDump, RecallSummary } from '@/recall'
import { SectionPicker } from '@/section-picker'
import { space } from '@/theme'
import { Button, ErrorText, Group, Loading, Screen, Text, Tile } from '@/ui'
import { formatClock, useNow } from '@/useNow'

const BREAK_MS = 5 * 60 * 1000

function BreakScreen({ onNext, onDone }: { onNext(): void; onDone(): void }) {
	const [breakEnds] = useState(() => Date.now() + BREAK_MS)
	const now = useNow(true)
	const left = breakEnds - now
	return (
		<Screen
			footer={
				<Group gap={space.sm}>
					<Button title="Back to reading" onPress={onNext} kind={left > 0 ? 'outline' : 'primary'} />
					<Button title="Done for now" kind="outline" onPress={onDone} />
				</Group>
			}
		>
			<Text variant="title">{left > 0 ? `Break, ${formatClock(left)}` : 'Break is over'}</Text>
			<Text>
				{left > 0
					? 'Stand up, look away from the screen, and let it settle. A real break makes the next session sharper.'
					: 'Ready for another focus session? Missed answers come back in about 10 minutes and again tomorrow.'}
			</Text>
		</Screen>
	)
}

export default function Test() {
	const { id, afterSession } = useLocalSearchParams<{ id: string; afterSession?: string }>()
	const router = useRouter()
	const queryClient = useQueryClient()
	const data = useQuery({
		queryKey: ['item', id],
		queryFn: () => api.item(id),
		refetchInterval: (q) => (q.state.data?.item.status === 'processing' ? 3000 : false),
	})
	const key = useQuery({ queryKey: ['key'], queryFn: api.key })
	const me = useQuery({ queryKey: ['me'], queryFn: api.me })
	const [selected, setSelected] = useState<Set<string>>(new Set())
	const [stage, setStage] = useState<
		{ name: 'pick' } | { name: 'recall' } | { name: 'test'; recall: Recall; questions: Question[] } | { name: 'break' }
	>({ name: 'pick' })
	// The brain dump decides the order: what it missed is asked first.
	const start = useMutation({
		mutationFn: (recall: Recall) => api.testQuestions(id, [...selected], recall.id).then((r) => ({ recall, questions: r.questions })),
		onSuccess: ({ recall, questions }) => setStage({ name: 'test', recall, questions }),
	})

	const leave = (home: boolean) => {
		queryClient.invalidateQueries({ queryKey: ['today'] })
		if (home) router.dismissTo('/')
		else router.back()
	}

	if (data.isPending) return <Loading />
	if (data.error)
		return (
			<Screen>
				<ErrorText error={data.error} />
			</Screen>
		)
	const { item, sections } = data.data
	// Tests only ask questions that exist; they are written in Manage test, never here.
	const hasQuestions = (s: { questionCount: number }) => s.questionCount > 0
	const picked = sections.filter((s) => selected.has(s.id) && hasQuestions(s))

	if (stage.name === 'break') return <BreakScreen onNext={() => leave(false)} onDone={() => leave(true)} />
	if (stage.name === 'recall')
		return start.isPending || start.error ? (
			<Screen footer={start.error ? <Button title="Back" onPress={() => setStage({ name: 'pick' })} /> : undefined}>
				{start.error ? <ErrorText error={start.error} /> : <Loading />}
			</Screen>
		) : (
			<BrainDump itemId={id} sectionIds={[...selected]} title={item.title} onDone={(recall) => start.mutate(recall)} />
		)
	if (stage.name === 'test') {
		if (!stage.questions.length)
			return (
				<Screen footer={<Button title="Pick other sections" onPress={() => setStage({ name: 'pick' })} />}>
					<Text>There are no questions for these sections.</Text>
				</Screen>
			)
		return (
			<PracticeSession
				title={item.title}
				questions={stage.questions}
				before={<RecallSummary recall={stage.recall} itemId={id} />}
				doneLabel={afterSession ? 'Take a 5-minute break' : 'Done'}
				onDone={() => (afterSession ? setStage({ name: 'break' }) : leave(false))}
			/>
		)
	}

	const linked = data.data.links.filter((l) => l.sectionIds.every((id) => selected.has(id))).length
	const count = sections.filter((s) => selected.has(s.id)).reduce((n, s) => n + s.questionCount, 0) + linked
	const manage = <Button title="Manage test" kind="outline" onPress={() => router.replace({ pathname: '/manage/[id]', params: { id } })} />
	if (!sections.some(hasQuestions))
		return (
			<Screen footer={manage}>
				<Group>
					<Text variant="muted">{item.title}</Text>
					<Text variant="title">No questions yet</Text>
					<Text variant="muted">
						{item.status === 'processing'
							? 'Your questions are being written. They show up here when they are ready.'
							: 'Pick the sections to be tested on in Manage test, and it writes their questions.'}
					</Text>
				</Group>
			</Screen>
		)
	return (
		<Screen
			footer={
				<Button
					title={picked.length ? `Test me on ${count} question${count === 1 ? '' : 's'}` : 'Pick what to be tested on'}
					onPress={() => setStage({ name: 'recall' })}
					disabled={!picked.length}
				/>
			}
		>
			<Group>
				<Text variant="muted">{item.title}</Text>
				<Text variant="title">What should the test cover?</Text>
				<Text variant="muted">Pick the sections you studied. You start by writing down everything you remember, then answer questions. You see every answer at the end.</Text>
			</Group>
			{key.data && !key.data.key && me.data && (item.questionStyle ?? me.data.questionStyle) !== 'choice' && (
				<Tile onPress={() => router.push('/llm-key')}>
					<Text>Written answers need your AI to check them</Text>
					<Text variant="muted">Connect your Anthropic or OpenAI key. Multiple choice works without it.</Text>
				</Tile>
			)}
			<SectionPicker sections={sections} selected={selected} onChange={setSelected} canPick={hasQuestions} />
			{sections.some((s) => s.wordCount > 0 && !hasQuestions(s)) && (
				<Text variant="muted">Greyed-out sections have no questions yet. Add them in Manage test.</Text>
			)}
		</Screen>
	)
}
