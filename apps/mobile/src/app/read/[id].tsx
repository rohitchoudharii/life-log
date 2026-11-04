import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router'
import { blockText } from '@peak/core'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Platform, Pressable, ScrollView, View } from 'react-native'
import { api, type Note, type Section, type StudySession } from '@/api'
import { BlockView } from '@/blocks'
import { BucketPicker } from '@/buckets'
import { ExplanationView, Passage } from '@/notes'
import { cancelSessionEnd, scheduleSessionEnd } from '@/reminders'
import { font, hairline, space, useColors } from '@/theme'
import { Button, Choice, ChoiceRow, ErrorText, Group, Loading, Row, Text } from '@/ui'
import { formatClock, useNow } from '@/useNow'

const DURATIONS = [15, 25, 45]
/** The clock stays hidden so it does not pull attention, until the last seconds. */
const SHOW_CLOCK_MS = 15_000

const squash = (text: string) => text.replace(/\s+/g, ' ').trim()

/**
 * On the web, text selected in the reader, with the section it is in, so it can be explained.
 * A selection across sections belongs to the section it starts in.
 */
function useWebSelection(sections: Section[] | undefined) {
	const [selection, setSelection] = useState<{ text: string; sectionId: string } | null>(null)
	useEffect(() => {
		if (Platform.OS !== 'web' || !sections) return
		const texts = sections.map((s) => ({ id: s.id, text: squash(s.blocks.map(blockText).join(' ')) }))
		const onChange = () => {
			const text = squash(window.getSelection()?.toString() ?? '')
			const start = text.slice(0, 40)
			const section = text.length >= 3 ? texts.find((s) => s.text.includes(start)) : undefined
			setSelection(section ? { text, sectionId: section.id } : null)
		}
		document.addEventListener('selectionchange', onChange)
		return () => document.removeEventListener('selectionchange', onChange)
	}, [sections])
	return selection
}

function SavedExplanation({ note, onDelete }: { note: Extract<Note, { kind: 'explanation' }>; onDelete(): void }) {
	return (
		<Group gap={space.md}>
			<Passage text={note.passage ?? ''} />
			<ExplanationView note={note} />
			<Pressable accessibilityRole="button" onPress={onDelete} hitSlop={8} style={{ alignSelf: 'flex-start' }}>
				<Text variant="muted">Delete</Text>
			</Pressable>
		</Group>
	)
}

const headingStyle = (level: number) =>
	level === 1
		? { fontSize: 22, lineHeight: 28 }
		: level === 2
			? { fontSize: 18, lineHeight: 25 }
			: { fontSize: 16, lineHeight: 23 }

export default function Reader() {
	const { id } = useLocalSearchParams<{ id: string }>()
	const router = useRouter()
	const c = useColors()
	const queryClient = useQueryClient()
	const data = useQuery({
		queryKey: ['item', id],
		queryFn: () => api.item(id),
		refetchInterval: (q) => (q.state.data?.item.status === 'processing' ? 3000 : false),
	})
	const { refetch } = data
	const notes = useQuery({ queryKey: ['notes', id], queryFn: () => api.notes(id) })
	const refetchNotes = notes.refetch
	useFocusEffect(useCallback(() => void (refetch(), refetchNotes()), [refetch, refetchNotes]))
	const selection = useWebSelection(data.data?.sections)
	const deleteNote = useMutation({ mutationFn: api.deleteNote, onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notes', id] }) })
	const explanations = (notes.data?.notes ?? []).filter((n): n is Extract<Note, { kind: 'explanation' }> => n.kind === 'explanation')

	const [minutes, setMinutes] = useState(25)
	const session = data.data?.activeSession ?? null
	const now = useNow(Boolean(session))
	const endsAt = session ? new Date(session.startedAt).getTime() + session.plannedMinutes * 60_000 : 0
	const timeUp = Boolean(session) && now >= endsAt

	const setSession = (s: StudySession | null) =>
		queryClient.setQueryData(['item', id], (old: typeof data.data) => old && { ...old, activeSession: s })

	const start = useMutation({
		mutationFn: () => api.startSession(id, minutes),
		onSuccess: ({ session: s }) => {
			setSession(s)
			scheduleSessionEnd(new Date(new Date(s.startedAt).getTime() + s.plannedMinutes * 60_000))
		},
	})
	const finish = useMutation({
		mutationFn: () => api.finishSession(session!.id),
		onSuccess: () => {
			cancelSessionEnd()
			setSession(null)
			queryClient.invalidateQueries({ queryKey: ['today'] })
			router.push({ pathname: '/test/[id]', params: { id, afterSession: '1' } })
		},
	})
	const cancel = useMutation({
		mutationFn: () => api.cancelSession(session!.id),
		onSuccess: () => {
			cancelSessionEnd()
			setSession(null)
		},
	})
	const rewrite = useMutation({
		mutationFn: () => api.rewriteQuestions(id),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ['item', id] })
			queryClient.invalidateQueries({ queryKey: ['items'] })
		},
	})
	const move = useMutation({
		mutationFn: (collectionId: string | null) => api.moveItem(id, collectionId),
		onSettled: () => {
			queryClient.invalidateQueries({ queryKey: ['items'] })
			queryClient.invalidateQueries({ queryKey: ['item', id] })
		},
	})
	const remove = useMutation({
		mutationFn: () => api.deleteItem(id),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ['items'] })
			router.back()
		},
	})

	// When the focus block ends, go straight to picking what to be tested on.
	const ended = useRef<string | null>(null)
	const { mutate: finishSession } = finish
	useEffect(() => {
		if (session && timeUp && ended.current !== session.id) {
			ended.current = session.id
			finishSession()
		}
	}, [session, timeUp, finishSession])

	if (data.isPending) return <Loading />
	if (data.error) return <ErrorText error={data.error} />
	const { item, sections } = data.data
	const left = endsAt - now

	const footer = session ? (
		<Group gap={space.md}>
			<Row>
				<Group gap={2}>
					<Text style={{ fontFamily: font.semibold, fontSize: 20, fontVariant: ['tabular-nums'] }}>
						{timeUp ? "Time's up" : left <= SHOW_CLOCK_MS ? formatClock(left) : 'Focusing'}
					</Text>
					<Text variant="muted">{session.plannedMinutes}-minute focus session</Text>
				</Group>
				<Pressable accessibilityRole="button" onPress={() => cancel.mutate()} hitSlop={8}>
					<Text variant="muted">Cancel</Text>
				</Pressable>
			</Row>
			<Button title="Stop and test me" onPress={() => finish.mutate()} loading={finish.isPending} />
		</Group>
	) : (
		// Kept to two rows so a small phone still shows most of the page.
		<Group gap={space.sm}>
			<ChoiceRow>
				{DURATIONS.map((m) => (
					<Choice key={m} label={`${m} min`} selected={minutes === m} onPress={() => setMinutes(m)} />
				))}
			</ChoiceRow>
			<Row style={{ gap: space.sm }}>
				<Button title="Start focus" onPress={() => start.mutate()} loading={start.isPending} style={{ flex: 3 }} />
				<Button title="Test me" kind="outline" onPress={() => router.push({ pathname: '/test/[id]', params: { id } })} style={{ flex: 2 }} />
			</Row>
			<ErrorText error={start.error} />
		</Group>
	)

	return (
		<View style={{ flex: 1, backgroundColor: c.bg }}>
			<ScrollView
				contentContainerStyle={{
					paddingHorizontal: space.screenX,
					paddingTop: space.xl,
					paddingBottom: 96,
					width: '100%',
					maxWidth: 680,
					alignSelf: 'center',
					gap: 36,
				}}
			>
				<Text variant="title">{item.title}</Text>
				{item.questionsOnDemand && <Text variant="muted">A long reading: questions are written chapter by chapter, when you pick chapters to be tested on.</Text>}
				{item.status === 'needs_key' && <Text variant="muted">Connect your AI in Settings so it can write questions for this.</Text>}
				{item.status === 'failed' && <Text variant="muted">Could not write questions: {item.error}</Text>}
				{sections.map((s, i) => (
					<View key={s.id} style={{ gap: space.lg }}>
						{/* Text before the first heading is named after the reading; its title is already shown. */}
						{!(i === 0 && s.title === item.title) && (
							<Text variant="heading" style={headingStyle(s.level)}>
								{s.title}
							</Text>
						)}
						{s.blocks.map((b, j) =>
							// Phones explain a block on long-press; the web explains selected text instead, so dragging to select stays free.
							Platform.OS === 'web' || b.type === 'image' || b.type === 'page' ? (
								<BlockView key={j} block={b} />
							) : (
								<Pressable
									key={j}
									onLongPress={() => router.push({ pathname: '/explain/[id]', params: { id, section: s.id, block: String(j) } })}
									accessibilityHint="Long-press to have it explained"
								>
									<BlockView block={b} selectable={false} />
								</Pressable>
							),
						)}
					</View>
				))}
				{explanations.length > 0 && (
					<Group gap={space.lg}>
						<Text variant="heading">Your explanations</Text>
						{explanations.map((n) => (
							<SavedExplanation key={n.id} note={n} onDelete={() => deleteNote.mutate(n.id)} />
						))}
					</Group>
				)}
				<Group gap={space.sm}>
					<Text variant="muted">
						{Platform.OS === 'web' ? 'Select any text to have it explained.' : 'Long-press a paragraph to have it explained.'} Teach an idea back to find what you cannot explain yet.
					</Text>
					<Button title="Teach it back" kind="outline" onPress={() => router.push({ pathname: '/teach/[id]', params: { id } })} />
				</Group>
				<Group gap={space.sm}>
					<BucketPicker value={item.collectionId} onChange={(id) => move.mutate(id)} />
					<ErrorText error={move.error} />
					{item.status !== 'processing' && item.status !== 'needs_key' && (
						<Button title="Rewrite questions with the new rules" kind="outline" onPress={() => rewrite.mutate()} loading={rewrite.isPending} />
					)}
					{item.status === 'processing' && <Text variant="muted">Your AI is writing questions…</Text>}
					<ErrorText error={rewrite.error} />
					<Button title="Delete from library" kind="outline" onPress={() => remove.mutate()} loading={remove.isPending} />
				</Group>
			</ScrollView>
			<View
				style={{
					paddingHorizontal: space.screenX,
					paddingTop: space.md,
					paddingBottom: space.lg,
					borderTopWidth: hairline,
					borderColor: c.ring,
					backgroundColor: c.bg,
					width: '100%',
					maxWidth: 680,
					alignSelf: 'center',
				}}
			>
				{selection ? (
					<Button
						title="Explain selection"
						onPress={() => router.push({ pathname: '/explain/[id]', params: { id, section: selection.sectionId, text: selection.text.slice(0, 4000) } })}
					/>
				) : (
					footer
				)}
				<ErrorText error={finish.error ?? cancel.error} />
			</View>
		</View>
	)
}
