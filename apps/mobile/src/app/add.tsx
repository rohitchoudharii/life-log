import { useMutation, useQueryClient } from '@tanstack/react-query'
import * as DocumentPicker from 'expo-document-picker'
import { useRouter } from 'expo-router'
import { useState } from 'react'
import { api } from '@/api'
import { BucketPicker } from '@/buckets'
import { space } from '@/theme'
import { Button, Choice, ChoiceRow, ErrorText, Field, Group, Row, Screen, Text, Toggle } from '@/ui'

export default function Add() {
	const router = useRouter()
	const queryClient = useQueryClient()
	const [mode, setMode] = useState<'link' | 'file' | 'text'>('link')
	const [url, setUrl] = useState('')
	const [importLinks, setImportLinks] = useState(false)
	const [file, setFile] = useState<DocumentPicker.DocumentPickerAsset | null>(null)
	const [title, setTitle] = useState('')
	const [text, setText] = useState('')
	const [collectionId, setCollectionId] = useState<string | null>(null)
	const add = useMutation({
		mutationFn: () => {
			const prefs = { collectionId }
			if (mode === 'link') return api.addUrl({ url: url.trim(), importLinks, ...prefs })
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
							Up to 50 MB, without DRM. Chapters become sections. Scanned PDFs without text can&apos;t be read yet.
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
							Life Log Club fetches the page and keeps only the article: its text, headings, and images. PDF links work too. For pages you need to be signed in to see, use the Chrome extension.
						</Text>
						<Row style={{ gap: space.md, marginTop: space.sm }}>
							<Group gap={2} style={{ flex: 1 }}>
								<Text>Import the pages it links to</Text>
								<Text variant="muted">
									{importLinks
										? 'Each linked page becomes a reading inside this one, in the background. Pages that need a sign-in are skipped.'
										: 'Links stay underlined while you read: tap one to open it or import it then.'}
								</Text>
							</Group>
							<Toggle accessibilityLabel="Import the pages it links to" value={importLinks} onValueChange={setImportLinks} />
						</Row>
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
				<ErrorText error={add.error} />
			</Group>
		</Screen>
	)
}
