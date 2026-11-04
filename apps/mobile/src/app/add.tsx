import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'expo-router'
import { useState } from 'react'
import type { QuestionIntensity, QuestionStyle } from '@peak/core'
import { api } from '@/api'
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
	const [title, setTitle] = useState('')
	const [text, setText] = useState('')
	const [questionIntensity, setIntensity] = useState<QuestionIntensity>('thorough')
	const [questionStyle, setStyle] = useState<QuestionStyle>('mixed')
	const add = useMutation({
		mutationFn: () => api.addItem({ title, text, questionIntensity, questionStyle }),
		onSuccess: ({ item }) => {
			queryClient.invalidateQueries({ queryKey: ['items'] })
			router.replace(`/read/${item.id}`)
		},
	})
	const words = text.split(/\s+/).filter(Boolean).length

	return (
		<Screen footer={<Button title="Add and start reading" onPress={() => add.mutate()} loading={add.isPending} disabled={!title.trim() || words < 10} />}>
			<Text variant="muted">
				Paste an article, notes, or a chapter. Markdown headings (#, ##, ###) become sections and subsections, and you choose which ones to be tested on.
			</Text>
			<Group gap={space.lg}>
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
