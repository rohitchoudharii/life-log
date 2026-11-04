import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useState } from 'react'
import { ActivityIndicator, Pressable, TextInput, View } from 'react-native'
import { api, type IdeaRef, type Note } from '@/api'
import { PointRow } from '@/practice'
import { font, hairline, radius, space, useColors } from '@/theme'
import { Button, ErrorText, Group, Loading, Row, Screen, Text, Tile } from '@/ui'

type Feynman = Extract<Note, { kind: 'feynman' }>

function Bubble({ who, text }: { who: 'learner' | 'student'; text: string }) {
	const c = useColors()
	const mine = who === 'learner'
	return (
		<View
			style={{
				alignSelf: mine ? 'flex-end' : 'flex-start',
				maxWidth: '88%',
				gap: 2,
				padding: space.md,
				borderRadius: radius,
				borderWidth: hairline,
				borderColor: mine ? c.ring : c.fg,
			}}
		>
			<Text variant="label">{mine ? 'You' : 'Student'}</Text>
			<Text selectable>{text}</Text>
		</View>
	)
}

function IdeaPicker({ itemId, onPick }: { itemId: string; onPick(idea: IdeaRef): void }) {
	const ideas = useQuery({ queryKey: ['ideas', itemId], queryFn: () => api.ideas(itemId) })
	if (ideas.isPending) return <Loading />
	const list = ideas.data?.ideas ?? []
	const sections = [...new Set(list.map((i) => i.section))]
	return (
		<Screen>
			<Group>
				<Text variant="title">Teach it back</Text>
				<Text variant="muted">Pick an idea and explain it to a curious student, without the text. The student asks until it finds what you cannot explain yet.</Text>
			</Group>
			<ErrorText error={ideas.error} />
			{!list.length && !ideas.error ? <Text variant="muted">This reading has no key ideas yet. They are listed once its questions are written.</Text> : null}
			{sections.map((section) => (
				<Group key={section} gap={space.sm}>
					<Text variant="label">{section}</Text>
					{list
						.filter((i) => i.section === section)
						.map((idea) => (
							<Tile key={idea.id} onPress={() => onPick(idea)}>
								<Text>{idea.text}</Text>
							</Tile>
						))}
				</Group>
			))}
		</Screen>
	)
}

/**
 * Feynman mode: the learner teaches one idea; the AI plays a student who asks up to three
 * follow-ups, then names the gaps. Ideas with gaps come back for review soon.
 */
export default function Teach() {
	const { id, idea: ideaParam } = useLocalSearchParams<{ id: string; idea?: string }>()
	const router = useRouter()
	const c = useColors()
	const queryClient = useQueryClient()
	const ideas = useQuery({ queryKey: ['ideas', id], queryFn: () => api.ideas(id), enabled: Boolean(ideaParam) })
	const [picked, setPicked] = useState<IdeaRef | null>(null)
	const [note, setNote] = useState<Feynman | null>(null)
	const [draft, setDraft] = useState('')
	const [showChat, setShowChat] = useState(false)
	const idea = picked ?? ideas.data?.ideas.find((i) => i.id === ideaParam) ?? null

	const send = useMutation({
		mutationFn: (text: string) => (note ? api.teach(note.id, text) : api.startTeaching(idea!.id, text)),
		onSuccess: ({ note: next }) => {
			setNote(next as Feynman)
			setDraft('')
			if (next.kind === 'feynman' && next.detail.result) {
				queryClient.invalidateQueries({ queryKey: ['due'] })
				queryClient.invalidateQueries({ queryKey: ['today'] })
			}
		},
	})

	if (ideaParam && ideas.isPending) return <Loading />
	if (!idea) return <IdeaPicker itemId={id} onPick={setPicked} />

	const messages = note?.detail.messages ?? []
	const result = note?.detail.result ?? null
	const pending = send.isPending ? send.variables : null
	const restart = () => {
		setNote(null)
		setPicked(null)
		setDraft('')
		send.reset()
		if (ideaParam) router.setParams({ idea: undefined })
	}

	return (
		<Screen
			stickToEnd={!result}
			footer={
				result ? (
					<Group gap={space.sm}>
						<Button title="Teach another idea" kind="outline" onPress={restart} />
						<Button title="Done" onPress={() => router.back()} />
					</Group>
				) : (
					<Group gap={space.sm}>
						<TextInput
							value={draft}
							onChangeText={setDraft}
							placeholder={messages.length ? 'Answer the student' : 'Explain it as if to someone new'}
							placeholderTextColor={c.sub}
							accessibilityLabel="Your explanation"
							multiline
							editable={!send.isPending}
							textAlignVertical="top"
							style={{
								minHeight: messages.length ? 72 : 140,
								maxHeight: 220,
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
						<Button title={messages.length ? 'Send' : 'Start teaching'} onPress={() => send.mutate(draft.trim())} loading={send.isPending} disabled={!draft.trim()} />
						<ErrorText error={send.error} />
					</Group>
				)
			}
		>
			<Group gap={space.sm}>
				<Text variant="muted">Teach it back</Text>
				<Text variant="heading">{idea.text}</Text>
				{!messages.length && <Text variant="muted">Close the text. Explain the idea in your own words: what it says, why it is true, and an example. The student will ask about whatever you leave unclear.</Text>}
			</Group>
			{/* Once the student sums up, the outcome comes first and the conversation folds away. */}
			{result && (
				<Tile style={{ gap: space.md, paddingVertical: space.lg }}>
					<Text style={{ fontFamily: font.semibold }}>{result.gaps.length ? `${result.gaps.length} gap${result.gaps.length === 1 ? '' : 's'} found` : 'No gaps found'}</Text>
					{result.summary ? <Text>{result.summary}</Text> : null}
					{result.gaps.length ? (
						<Group gap={space.xs}>
							<Text variant="label">What to learn</Text>
							{result.gaps.map((g, i) => (
								<PointRow key={i} text={g} status="missing" />
							))}
						</Group>
					) : null}
					{result.strengths.length ? (
						<Group gap={space.xs}>
							<Text variant="label">What you explained well</Text>
							{result.strengths.map((g, i) => (
								<PointRow key={i} text={g} status="covered" />
							))}
						</Group>
					) : null}
					{result.gaps.length ? <Text variant="muted">This idea comes back for review within about 10 minutes.</Text> : null}
				</Tile>
			)}
			{result && (
				<Pressable accessibilityRole="button" onPress={() => setShowChat(!showChat)} hitSlop={8} style={{ alignSelf: 'flex-start' }}>
					<Text variant="muted">{showChat ? 'Hide the conversation' : 'Show the conversation'}</Text>
				</Pressable>
			)}
			<Group gap={space.md}>
				{(!result || showChat) && messages.map((m, i) => (
					<Bubble key={i} who={m.role} text={m.text} />
				))}
				{pending ? <Bubble who="learner" text={pending} /> : null}
				{send.isPending && (
					<Row style={{ justifyContent: 'flex-start' }}>
						<ActivityIndicator color={c.fg} size="small" />
						<Text variant="muted">The student is thinking…</Text>
					</Row>
				)}
			</Group>
		</Screen>
	)
}
