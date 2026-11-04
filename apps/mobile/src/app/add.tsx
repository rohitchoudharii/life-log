import { useMutation, useQueryClient } from '@tanstack/react-query'
import * as DocumentPicker from 'expo-document-picker'
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
	{ value: 'choice', label: 'Choice' },
]

export default function Add() {
	const router = useRouter()
	const queryClient = useQueryClient()
	const [mode, setMode] = useState<'link' | 'file' | 'text'>('link')
	const [url, setUrl] = useState('')
	const [file, setFile] = useState<DocumentPicker.DocumentPickerAsset | null>(null)
	const [title, setTitle] = useState('')
	const [text, setText] = useState('')
	const [questionIntensity, setIntensity] = useState<QuestionIntensity>('thorough')
	const [questionStyle, setStyle] = useState<QuestionStyle>('mixed')
	const [collectionId, setCollectionId] = useState<string | null>(null)
	const add = useMutation({
		mutationFn: () => {
			const prefs = { questionIntensity, questionStyle, collectionId }
			if (mode === 'link') return api.addUrl({ url: url.trim(), ...prefs })
			if (mode === 'file' && file)
				return api.uploadItem(file.file ?? { uri: file.uri, name: file.name, type: file.mimeType ?? 'application/octet-stream' }, prefs)
			return api.addItem({ title, text, ...prefs })
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
					title={add.isPending && mode === 'link' ? 'Fetching the page…' : add.isPending && mode === 'file' ? 'Reading the file…' : 'Add and start reading'}
					onPress={() => add.mutate()}
					loading={add.isPending}
					disabled={mode === 'link' ? !url.trim() : mode === 'file' ? !file : !title.trim() || words < 10}
				/>
			}
		>
			<ChoiceRow>
				<Choice label="Link" selected={mode === 'link'} onPress={() => setMode('link')} />
				<Choice label="Book or PDF" selected={mode === 'file'} onPress={() => setMode('file')} />
				<Choice label="Text" selected={mode === 'text'} onPress={() => setMode('text')} />
			</ChoiceRow>
			<Group gap={space.lg}>
				{mode === 'file' ? (
					<Group gap={space.sm}>
						<Button
							title={file ? file.name : 'Choose an EPUB or PDF'}
							kind="outline"
							onPress={async () => {
								const picked = await DocumentPicker.getDocumentAsync({ type: ['application/epub+zip', 'application/pdf'], copyToCacheDirectory: true })
								if (!picked.canceled) setFile(picked.assets[0] ?? null)
							}}
						/>
						<Text variant="muted">
							Up to 50 MB, without DRM. Chapters become sections. For long books, questions are written chapter by chapter when you pick chapters to be tested on. Scanned PDFs without text can&apos;t be read yet.
						</Text>
					</Group>
				) : mode === 'link' ? (
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
							Peak fetches the page and keeps only the article: its text, headings, and images. PDF links work too. For pages you need to be signed in to see, use the Chrome extension.
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
							? 'Multiple choice and putting steps in order, graded instantly without your AI.'
							: questionStyle === 'written'
								? 'Explain it, work out a number, predict what code prints, find the error. Numbers and outputs are checked exactly; explanations by your AI. Harder, and they stick better.'
								: 'Peak picks the type that fits each idea: code gets predict the output and find the error, math gets worked problems, processes get steps to order.'}
					</Text>
				</Group>
				<ErrorText error={add.error} />
			</Group>
		</Screen>
	)
}
