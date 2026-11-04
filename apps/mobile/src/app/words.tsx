import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Pressable, TextInput } from 'react-native'
import { api, type Word } from '@/api'
import { PracticeSession } from '@/practice'
import { font, hairline, radius, space, useColors } from '@/theme'
import { Button, ErrorText, Group, Loading, Row, Screen, Text, Tile } from '@/ui'
import { useNow } from '@/useNow'

const STAGE = ['Fill the word', 'What it means', 'Use it']

function WordTile({ word, onDelete }: { word: Word; onDelete(): void }) {
	return (
		<Tile style={{ gap: space.sm }}>
			<Row>
				<Text style={{ fontFamily: font.semibold }}>{word.word}</Text>
				<Text variant="muted">{word.mastered ? 'Learned' : word.dueAt ? STAGE[Math.min(word.level, 2)] : 'New'}</Text>
			</Row>
			<Text>{word.meaning}</Text>
			<Text variant="muted">{word.sentence}</Text>
			<Row>
				<Text variant="muted" numberOfLines={1} style={{ flex: 1 }}>
					{word.itemTitle ?? 'Added by you'}
				</Text>
				<Pressable accessibilityRole="button" accessibilityLabel={`Delete ${word.word}`} onPress={onDelete} hitSlop={8}>
					<Text variant="muted">Delete</Text>
				</Pressable>
			</Row>
		</Tile>
	)
}

/**
 * Vocabulary: terms picked out of readings, plus words added by hand. Each is spaced like an
 * idea; its test goes from filling it into its sentence, to saying what it means, to using it.
 */
export default function Words() {
	const c = useColors()
	const queryClient = useQueryClient()
	const [session, setSession] = useState<Awaited<ReturnType<typeof api.wordsDue>>['questions'] | null>(null)
	const [word, setWord] = useState('')
	const [sentence, setSentence] = useState('')
	const words = useQuery({ queryKey: ['words'], queryFn: api.words, enabled: !session })
	const start = useMutation({ mutationFn: api.wordsDue, onSuccess: ({ questions }) => questions.length && setSession(questions) })
	const add = useMutation({
		mutationFn: () => api.addWord({ word: word.trim(), sentence: sentence.trim() || undefined }),
		onSuccess: () => {
			setWord('')
			setSentence('')
			queryClient.invalidateQueries({ queryKey: ['words'] })
		},
	})
	const now = useNow(false)
	const remove = useMutation({ mutationFn: api.deleteWord, onSuccess: () => queryClient.invalidateQueries({ queryKey: ['words'] }) })

	if (session)
		return (
			<PracticeSession
				title="Vocabulary"
				questions={session}
				submit={api.answerWord}
				onDone={() => {
					setSession(null)
					queryClient.invalidateQueries({ queryKey: ['words'] })
				}}
			/>
		)
	if (words.isPending) return <Loading />
	const list = words.data?.words ?? []
	const due = list.filter((w) => !w.dueAt || new Date(w.dueAt).getTime() <= now).length
	const field = {
		fontFamily: font.regular,
		fontSize: 16,
		lineHeight: 24,
		color: c.fg,
		borderWidth: hairline,
		borderColor: c.ring,
		outlineColor: c.fg,
		borderRadius: radius,
		padding: space.md,
	}

	return (
		<Screen footer={due ? <Button title={`Practise ${Math.min(due, 30)} word${due === 1 ? '' : 's'}`} onPress={() => start.mutate()} loading={start.isPending} /> : undefined}>
			<Group>
				<Text variant="title">Vocabulary</Text>
				<Text variant="muted">Terms from your reading, and words you add. Each comes back spaced out: first you fill it into its sentence, then say what it means, then use it in a sentence of your own.</Text>
			</Group>
			<ErrorText error={words.error ?? start.error} />
			<Group gap={space.sm}>
				<Text variant="label">Add a word</Text>
				<TextInput value={word} onChangeText={setWord} placeholder="Word or term" placeholderTextColor={c.sub} accessibilityLabel="Word" autoCapitalize="none" style={field} />
				<TextInput
					value={sentence}
					onChangeText={setSentence}
					placeholder="The sentence you met it in (optional)"
					placeholderTextColor={c.sub}
					accessibilityLabel="Sentence"
					multiline
					style={[field, { minHeight: 72 }]}
				/>
				<Button title={add.isPending ? 'Looking it up…' : 'Add'} kind="outline" onPress={() => add.mutate()} loading={add.isPending} disabled={!word.trim()} />
				<ErrorText error={add.error} />
			</Group>
			<Group gap={space.sm}>
				<Text variant="label">
					{list.length} word{list.length === 1 ? '' : 's'}
					{due ? `, ${due} to practise` : ''}
				</Text>
				{!list.length && <Text variant="muted">Words appear here as your AI writes questions for new readings, or when you add one.</Text>}
				{list.map((w) => (
					<WordTile key={w.id} word={w} onDelete={() => remove.mutate(w.id)} />
				))}
			</Group>
		</Screen>
	)
}
