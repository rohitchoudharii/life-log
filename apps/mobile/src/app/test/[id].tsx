import Ionicons from '@expo/vector-icons/Ionicons'
import { subtreeEnd } from '@peak/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useMemo, useState, type ReactNode } from 'react'
import { Pressable, View } from 'react-native'
import { api, type Question, type Recall, type Section } from '@/api'
import { PracticeSession } from '@/practice'
import { BrainDump, RecallSummary } from '@/recall'
import { font, hairline, space, useColors } from '@/theme'
import { Button, Checkbox, ErrorText, Group, Loading, Progress, Row, Screen, Text, Tile } from '@/ui'
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

/**
 * The section tree as a checklist. Ticking a section ticks its subsections; a parent shows a
 * dash when only some of them are ticked.
 */
function SectionPicker({ sections, selected, onChange }: { sections: Section[]; selected: Set<string>; onChange(next: Set<string>): void }) {
	const c = useColors()
	const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
	const levels = useMemo(() => sections.map((s) => s.level), [sections])
	const range = (i: number) => sections.slice(i, subtreeEnd(levels, i))
	const stateOf = (list: Section[]) => {
		const n = list.filter((s) => selected.has(s.id)).length
		return n === 0 ? false : n === list.length ? true : ('mixed' as const)
	}
	const toggle = (list: Section[]) => {
		const next = new Set(selected)
		const on = stateOf(list) !== true
		list.forEach((s) => (on ? next.add(s.id) : next.delete(s.id)))
		onChange(next)
	}
	const questionsIn = (list: Section[]) => list.reduce((n, s) => n + s.questionCount, 0)

	const rows: ReactNode[] = []
	for (let i = 0; i < sections.length; i++) {
		const s = sections[i]!
		const subtree = range(i)
		const hasChildren = subtree.length > 1
		const isCollapsed = collapsed.has(s.id)
		const count = questionsIn(subtree)
		rows.push(
			<Row key={s.id} style={{ gap: 0, borderTopWidth: hairline, borderColor: c.ring }}>
				<Pressable
					accessibilityRole="checkbox"
					accessibilityState={{ checked: stateOf(subtree) }}
					onPress={() => toggle(subtree)}
					style={({ pressed }) => ({
						flex: 1,
						flexDirection: 'row',
						alignItems: 'center',
						gap: space.md,
						minHeight: 48,
						paddingVertical: space.sm,
						paddingLeft: (s.level - 1) * 24,
						opacity: pressed ? 0.6 : 1,
					})}
				>
					<Checkbox state={stateOf(subtree)} />
					<Text style={{ flex: 1, fontFamily: s.level === 1 ? font.medium : font.regular }}>{s.title}</Text>
					<Text variant="muted" style={{ fontVariant: ['tabular-nums'] }}>
						{count}
					</Text>
				</Pressable>
				<Pressable
					accessibilityRole="button"
					accessibilityLabel={isCollapsed ? `Show subsections of ${s.title}` : `Hide subsections of ${s.title}`}
					disabled={!hasChildren}
					onPress={() => {
						const next = new Set(collapsed)
						if (isCollapsed) next.delete(s.id)
						else next.add(s.id)
						setCollapsed(next)
					}}
					style={{ width: 40, height: 48, alignItems: 'center', justifyContent: 'center' }}
				>
					{hasChildren && <Ionicons name={isCollapsed ? 'chevron-down' : 'chevron-up'} size={16} color={c.sub} />}
				</Pressable>
			</Row>,
		)
		if (isCollapsed) i += subtree.length - 1
	}

	return (
		<Group gap={0}>
			<Row style={{ gap: 0 }}>
				<Pressable
					accessibilityRole="checkbox"
					accessibilityState={{ checked: stateOf(sections) }}
					onPress={() => toggle(sections)}
					style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 48 }}
				>
					<Checkbox state={stateOf(sections)} />
					<Text style={{ flex: 1, fontFamily: font.semibold }}>Select all</Text>
					<Text variant="muted" style={{ fontVariant: ['tabular-nums'] }}>
						{questionsIn(sections)}
					</Text>
				</Pressable>
				<View style={{ width: 40 }} />
			</Row>
			{rows}
		</Group>
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
	const [selected, setSelected] = useState<Set<string>>(new Set())
	const [stage, setStage] = useState<
		{ name: 'pick' } | { name: 'recall' } | { name: 'test'; recall: Recall; questions: Question[] } | { name: 'break' }
	>({ name: 'pick' })
	const prepare = useMutation({
		mutationFn: (sectionIds: string[]) => api.prepare(id, sectionIds),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['item', id] }),
	})
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
					<Text>There are no questions for these sections yet.</Text>
				</Screen>
			)
		return (
			<PracticeSession
				title={item.title}
				questions={stage.questions}
				before={<RecallSummary recall={stage.recall} />}
				doneLabel={afterSession ? 'Take a 5-minute break' : 'Done'}
				onDone={() => (afterSession ? setStage({ name: 'break' }) : leave(false))}
			/>
		)
	}

	const linked = data.data.links.filter((l) => l.sectionIds.every((id) => selected.has(id))).length
	const count = sections.filter((s) => selected.has(s.id)).reduce((n, s) => n + s.questionCount, 0) + linked
	// Books get questions per chapter: picked sections without any still need them written.
	const unwritten = item.questionsOnDemand ? sections.filter((s) => selected.has(s.id) && s.wordCount > 0 && s.questionCount === 0) : []
	const toWrite = unwritten.filter((s) => !s.questionsWanted || item.status !== 'processing')
	const chapterOf = (i: number) => {
		while (i > 0 && sections[i]!.level > 1) i--
		return i
	}
	const chapters = new Set(toWrite.map((s) => chapterOf(sections.indexOf(s)))).size
	const wanted = sections.filter((s) => s.questionsWanted && s.wordCount > 0)
	const written = wanted.filter((s) => s.questionCount > 0).length
	const testButton = (
		<Button
			title={
				count ? `Test me on ${count} question${count === 1 ? '' : 's'}` : unwritten.length && item.status === 'processing' ? 'Writing questions…' : 'Pick what to be tested on'
			}
			kind={toWrite.length ? 'outline' : 'primary'}
			onPress={() => setStage({ name: 'recall' })}
			disabled={!count}
		/>
	)
	return (
		<Screen
			footer={
				<Group gap={space.sm}>
					{toWrite.length > 0 && (
						<Button
							title={`Write questions for ${chapters} chapter${chapters === 1 ? '' : 's'}`}
							onPress={() => prepare.mutate(toWrite.map((s) => s.id))}
							loading={prepare.isPending}
						/>
					)}
					{(count > 0 || !toWrite.length) && testButton}
				</Group>
			}
		>
			<Group>
				<Text variant="muted">{item.title}</Text>
				<Text variant="title">What should the test cover?</Text>
				<Text variant="muted">Pick the sections you studied. You start by writing down everything you remember, then answer questions. You see every answer at the end.</Text>
			</Group>
			{item.questionsOnDemand && item.status !== 'processing' && (
				<Text variant="muted">This is a long reading, so questions are written chapter by chapter. Pick the chapters you studied, and your AI writes theirs.</Text>
			)}
			{item.status === 'processing' &&
				(item.questionsOnDemand && wanted.length ? (
					<Group gap={space.xs}>
						<Text variant="muted">
							Your AI is writing questions: {written} of {wanted.length} sections done. Each chapter takes about a minute.
						</Text>
						<Progress value={written / wanted.length} />
					</Group>
				) : (
					<Text variant="muted">Your AI is still writing questions. Counts update when it finishes.</Text>
				))}
			{item.status === 'failed' && <Text variant="muted">Writing questions failed: {item.error}. Pick the chapters again to retry.</Text>}
			<ErrorText error={prepare.error} />
			{item.status === 'needs_key' && <Text variant="muted">Connect your AI in Settings so it can write questions for this.</Text>}
			{key.data && !key.data.key && item.questionStyle !== 'choice' && (
				<Tile onPress={() => router.push('/llm-key')}>
					<Text>Written answers need your AI to check them</Text>
					<Text variant="muted">Connect your Anthropic or OpenAI key. Multiple choice works without it.</Text>
				</Tile>
			)}
			<SectionPicker sections={sections} selected={selected} onChange={setSelected} />
		</Screen>
	)
}
