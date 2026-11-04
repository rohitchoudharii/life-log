import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { useRouter } from 'expo-router'
import { Pressable, TextInput } from 'react-native'
import { api, type Recall } from './api'
import { PointRow } from './practice'
import { font, hairline, radius, space, useColors } from './theme'
import { Button, ErrorText, Group, Row, Screen, Text, Tile } from './ui'

const words = (text: string) => text.split(/\s+/).filter(Boolean).length

/**
 * The brain dump: before any question, the learner writes everything they remember. Free recall
 * right after reading is the strongest retrieval practice there is, so it cannot be skipped.
 */
export function BrainDump({ itemId, sectionIds, title, onDone }: { itemId: string; sectionIds: string[]; title: string; onDone(recall: Recall): void }) {
	const c = useColors()
	const [text, setText] = useState('')
	const submit = useMutation({
		mutationFn: () => api.recall(itemId, sectionIds, text),
		onSuccess: ({ recall }) => onDone(recall),
	})
	const n = words(text)
	return (
		<Screen
			footer={
				<Group gap={space.sm}>
					<Button
						title={submit.isPending ? 'Checking what you remembered…' : 'Done, start the questions'}
						onPress={() => submit.mutate()}
						loading={submit.isPending}
						disabled={!text.trim()}
					/>
					<ErrorText error={submit.error} />
				</Group>
			}
		>
			<Group>
				<Text variant="muted">{title}</Text>
				<Text variant="title">Write everything you remember</Text>
				<Text variant="muted">
					{"Don't look back at the text. Ideas, reasons, examples, how they connect: anything that comes back. Fragments and lists are fine."}
				</Text>
			</Group>
			<Group gap={space.xs}>
				<TextInput
					value={text}
					onChangeText={setText}
					placeholder="Start with whatever comes first"
					placeholderTextColor={c.sub}
					multiline
					autoFocus
					editable={!submit.isPending}
					textAlignVertical="top"
					accessibilityLabel="Brain dump"
					style={{
						minHeight: 280,
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
				<Text variant="muted" style={{ fontVariant: ['tabular-nums'] }}>
					{n} word{n === 1 ? '' : 's'}
				</Text>
			</Group>
		</Screen>
	)
}

/** How the brain dump went, shown at the top of the results: every key idea, marked. */
export function RecallSummary({ recall: initial, itemId }: { recall: Recall; itemId: string }) {
	const router = useRouter()
	const [recall, setRecall] = useState(initial)
	const regrade = useMutation({ mutationFn: () => api.regradeRecall(recall.id), onSuccess: (r) => setRecall(r.recall) })
	const graded = recall.ideas.filter((i) => i.status)
	const covered = graded.filter((i) => i.status === 'covered').length
	return (
		<Tile style={{ gap: space.md, paddingVertical: space.lg }}>
			<Row>
				<Text style={{ fontFamily: font.semibold }}>Brain dump</Text>
				{graded.length ? (
					<Text variant="muted" style={{ fontVariant: ['tabular-nums'] }}>
						{covered} of {recall.ideas.length} key ideas
					</Text>
				) : null}
			</Row>
			{recall.gradeError ? (
				<Group gap={space.sm}>
					<ErrorText error={recall.gradeError} />
					<Button title="Check my brain dump again" kind="outline" onPress={() => regrade.mutate()} loading={regrade.isPending} />
					<ErrorText error={regrade.error} />
				</Group>
			) : null}
			{recall.feedback ? <Text>{recall.feedback}</Text> : null}
			{graded.length ? (
				<Group gap={space.xs}>
					{recall.ideas.map((idea) => (
						<Pressable
							key={idea.id}
							accessibilityRole="button"
							accessibilityHint="Teach this idea back"
							onPress={() => router.push({ pathname: '/teach/[id]', params: { id: itemId, idea: idea.id } })}
						>
							<PointRow text={idea.text} status={idea.status ?? undefined} />
						</Pressable>
					))}
					<Text variant="muted">Tap an idea to teach it back.</Text>
				</Group>
			) : null}
			<Group gap={2}>
				<Text variant="label">What you wrote</Text>
				<Text selectable>{recall.text}</Text>
			</Group>
		</Tile>
	)
}
