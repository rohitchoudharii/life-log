import { View } from 'react-native'
import type { Note } from './api'
import { CodeBlock } from './blocks'
import { space, useColors } from './theme'
import { Group, Text } from './ui'

/** A passage quoted from the reading, set off by a rule like a quote block. */
export function Passage({ text }: { text: string }) {
	const c = useColors()
	return (
		<View style={{ paddingLeft: space.md, borderLeftWidth: 2, borderColor: c.ring }}>
			<Text selectable style={{ color: c.sub }}>
				{text}
			</Text>
		</View>
	)
}

/** The AI's explanation, with the sentence of the reading it rests on. */
export function ExplanationView({ note }: { note: Extract<Note, { kind: 'explanation' }> }) {
	const { text, code, quote } = note.detail
	return (
		<Group gap={space.md}>
			<Text selectable>{text}</Text>
			{code ? <CodeBlock code={code} wrap /> : null}
			{quote ? (
				<Group gap={space.xs}>
					<Text variant="label">From the text</Text>
					<Passage text={quote} />
				</Group>
			) : null}
		</Group>
	)
}

/** The sentence of `text` that uses `word`, or an inflection of it, for adding the word to the vocabulary. */
export function sentenceWith(text: string, word: string): string | undefined {
	const w = word.trim().toLowerCase()
	const stem = w.length > 5 ? w.slice(0, w.length - 2) : w
	return text
		.replace(/\s+/g, ' ')
		.split(/(?<=[.!?])\s+/)
		.find((s) => s.toLowerCase().includes(stem))
}
