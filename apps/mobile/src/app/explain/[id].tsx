import { blockText } from '@peak/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useState } from 'react'
import { TextInput } from 'react-native'
import { api, type ExplainKind, type ExplainLevel } from '@/api'
import { ExplanationView, Passage, sentenceWith } from '@/notes'
import { font, hairline, radius, space, useColors } from '@/theme'
import { Button, Choice, ChoiceRow, ErrorText, Group, Loading, Row, Screen, Text } from '@/ui'

const LEVELS: { value: ExplainLevel; label: string }[] = [
	{ value: 'new', label: 'New to this' },
	{ value: 'standard', label: 'Standard' },
	{ value: 'expert', label: 'Expert' },
]
const KINDS: { value: ExplainKind; label: string }[] = [
	{ value: 'explain', label: 'Explanation' },
	{ value: 'analogy', label: 'Analogy' },
	{ value: 'example', label: 'Example' },
]

/**
 * Explains a passage from the reader: a paragraph long-pressed on a phone, or text selected on
 * the web. Each explanation is kept with the item.
 */
export default function Explain() {
	const { id, section, block, text } = useLocalSearchParams<{ id: string; section: string; block?: string; text?: string }>()
	const router = useRouter()
	const queryClient = useQueryClient()
	const item = useQuery({ queryKey: ['item', id], queryFn: () => api.item(id) })
	const [level, setLevel] = useState<ExplainLevel>('standard')
	const [kind, setKind] = useState<ExplainKind>('explain')
	const c = useColors()
	const [word, setWord] = useState('')
	const addWord = useMutation({
		mutationFn: (passage: string) => api.addWord({ word: word.trim(), sentence: sentenceWith(passage, word), itemId: id }),
		onSuccess: () => {
			setWord('')
			queryClient.invalidateQueries({ queryKey: ['words'] })
		},
	})
	const explain = useMutation({
		mutationFn: (passage: string) => api.explain(id, { sectionId: section, passage, level, kind }),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notes', id] }),
	})

	if (item.isPending) return <Loading />
	const s = item.data?.sections.find((x) => x.id === section)
	const b = block !== undefined ? s?.blocks[Number(block)] : undefined
	const passage = (text ?? (b ? blockText(b) : '')).trim()
	const note = explain.data?.note

	return (
		<Screen
			footer={
				<Group gap={space.sm}>
					<Button
						title={explain.isPending ? 'Explaining…' : note ? 'Explain again' : 'Explain'}
						onPress={() => explain.mutate(passage)}
						loading={explain.isPending}
						disabled={!passage}
						kind={note ? 'outline' : 'primary'}
					/>
					{note && <Button title="Back to reading" onPress={() => router.back()} />}
				</Group>
			}
		>
			<ErrorText error={item.error} />
			<Group gap={space.sm}>
				<Text variant="muted">{s?.title}</Text>
				<Passage text={passage || 'Nothing to explain here.'} />
			</Group>
			<Group gap={space.xs}>
				<Text variant="label">You are</Text>
				<ChoiceRow>
					{LEVELS.map((o) => (
						<Choice key={o.value} label={o.label} selected={level === o.value} onPress={() => setLevel(o.value)} />
					))}
				</ChoiceRow>
			</Group>
			<Group gap={space.xs}>
				<Text variant="label">Give me</Text>
				<ChoiceRow>
					{KINDS.map((o) => (
						<Choice key={o.value} label={o.label} selected={kind === o.value} onPress={() => setKind(o.value)} />
					))}
				</ChoiceRow>
			</Group>
			<ErrorText error={explain.error} />
			<Group gap={space.xs}>
				<Text variant="label">Add a word from this</Text>
				<Row style={{ gap: space.sm }}>
					<TextInput
						value={word}
						onChangeText={setWord}
						placeholder="A word you want to learn"
						placeholderTextColor={c.sub}
						accessibilityLabel="Word to add"
						autoCapitalize="none"
						style={{ flex: 1, fontFamily: font.regular, fontSize: 16, color: c.fg, borderWidth: hairline, borderColor: c.ring, outlineColor: c.fg, borderRadius: radius, padding: space.md }}
					/>
					<Button title="Add" kind="outline" onPress={() => addWord.mutate(passage)} loading={addWord.isPending} disabled={!word.trim()} />
				</Row>
				{addWord.isSuccess && <Text variant="muted">Added {addWord.data.word.word} to your vocabulary.</Text>}
				<ErrorText error={addWord.error} />
			</Group>
			{note?.kind === 'explanation' && (
				<Group gap={space.sm}>
					<Text variant="label">Saved with this reading</Text>
					<ExplanationView note={note} />
				</Group>
			)}
		</Screen>
	)
}
