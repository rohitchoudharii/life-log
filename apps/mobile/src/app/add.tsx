import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'expo-router'
import { useState } from 'react'
import type { QuestionIntensity, QuestionStyle } from '@peak/core'
import { api } from '@/api'
import { BucketPicker } from '@/buckets'
import { space } from '@/theme'
import { Button, Choice, ChoiceRow, ErrorText, Field, Group, Screen, Text } from '@/ui'

const INTENSITIES: { value: QuestionIntensity; label: string; detail: string }[] = [
	{ value: 'quick', label: 'Quick', detail: 'Key ideas only' },
	{ value: 'standard', label: 'Standard', detail: 'Every main idea' },
	{ value: 'thorough', label: 'Thorough', detail: 'As many as possible' },
]

const STYLES: { value: QuestionStyle; label: string }[] = [
	{ value: 'mixed', label: 'Mixed' },
	{ value: 'written', label: 'Written' },
	{ value: 'choice', label: 'Multiple choice' },
]

export default function Add() {
	const router = useRouter()
	const queryClient = useQueryClient()
	const [mode, setMode] = useState<'link' | 'text'>('link')
	const [url, setUrl] = useState('')
	const [title, setTitle] = useState('')
	const [text, setText] = useState('')
	const [questionIntensity, setIntensity] = useState<QuestionIntensity>('thorough')
	const [questionStyle, setStyle] = useState<QuestionStyle>('mixed')
	const [collectionId, setCollectionId] = useState<string | null>(null)
	const add = useMutation({
		mutationFn: () => {
			const prefs = { questionIntensity, questionStyle, collectionId }
			return mode === 'link' ? api.addUrl({ url: url.trim(), ...prefs }) : api.addItem({ title, text, ...prefs })
		},
		onSuccess: ({ item }) => {
			queryClient.invalidateQueries({ queryKey: ['items'] })
			router.replace(`/read/${item.id}`)
		},
	})
	const words = text.split(/\s+/).filter(Boolean).length

	return (
		<Screen
			footer={
				<Button
					title={add.isPending && mode === 'link' ? 'Fetching the page…' : 'Add and start reading'}
					onPress={() => add.mutate()}
					loading={add.isPending}
					disabled={mode === 'link' ? !url.trim() : !title.trim() || words < 10}
				/>
			}
		>
			<ChoiceRow>
				<Choice label="Paste a link" selected={mode === 'link'} onPress={() => setMode('link')} />
				<Choice label="Paste text" selected={mode === 'text'} onPress={() => setMode('text')} />
			</ChoiceRow>
			<Group gap={space.lg}>
				{mode === 'link' ? (
					<Group gap={space.xs}>
						<Field
							label="Link"
							value={url}
							onChangeText={setUrl}
							placeholder="https://en.wikipedia.org/wiki/Spaced_repetition"
							autoCapitalize="none"
							autoCorrect={false}
							keyboardType="url"
							inputMode="url"
						/>
						<Text variant="muted">
							Peak fetches the page and keeps only the article: its text, headings, and images. For pages you need to be signed in to see, use the Chrome extension.
						</Text>
					</Group>
				) : (
					<>
						<Text variant="muted">
							Paste an article, notes, or a chapter. Markdown headings (#, ##, ###) become sections and subsections, and you choose which ones to be tested on.
						</Text>
						<Field label="Title" value={title} onChangeText={setTitle} placeholder="Attention Is All You Need" />
						<Field
							label={`Text${words ? `, ${words} words` : ''}`}
							value={text}
							onChangeText={setText}
							placeholder="Paste here"
							multiline
							textAlignVertical="top"
							style={{ minHeight: 260 }}
						/>
					</>
				)}
				<BucketPicker value={collectionId} onChange={setCollectionId} />
				<Group gap={space.xs}>
					<Text variant="label">How hard should the tests be?</Text>
					<ChoiceRow>
						{INTENSITIES.map((o) => (
							<Choice key={o.value} label={o.label} detail={o.detail} selected={questionIntensity === o.value} onPress={() => setIntensity(o.value)} />
						))}
					</ChoiceRow>
				</Group>
				<Group gap={space.xs}>
					<Text variant="label">Question style</Text>
					<ChoiceRow>
						{STYLES.map((o) => (
							<Choice key={o.value} label={o.label} selected={questionStyle === o.value} onPress={() => setStyle(o.value)} />
						))}
					</ChoiceRow>
					<Text variant="muted">
						{questionStyle === 'choice'
							? 'Multiple choice is graded instantly, without your AI.'
							: 'Written answers are graded by your AI. They take more effort and stick better.'}
					</Text>
				</Group>
				<ErrorText error={add.error} />
			</Group>
		</Screen>
	)
}
