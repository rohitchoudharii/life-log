import Ionicons from '@expo/vector-icons/Ionicons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter, type Href } from 'expo-router'
import { useState, type ReactNode } from 'react'
import { Platform, Pressable, View } from 'react-native'
import type { Block } from '@life-log-club/core'
import { api, type Item, type Note } from './api'
import { BucketPicker } from './buckets'
import { settingsLabel } from './question-settings'
import { ExplanationView, Passage } from './notes'
import { hairline, space, useColors } from './theme'
import { Button, ErrorText, Group, Progress, Row, Sheet, Text } from './ui'

/** A link's address without the scheme and www, short enough to read. */
export const shortUrl = (href: string) => href.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')

export type LinkedResource = { href: string; label: string }

/** Every page the reading links to, once each, in reading order, named by the text of its first link. */
export function linkedResources(blocks: readonly Block[]): LinkedResource[] {
	const seen = new Map<string, string>()
	for (const b of blocks) {
		if (!('links' in b) || !b.links) continue
		for (const l of b.links) {
			const text = b.type === 'list' ? (b.items[l.item ?? 0] ?? '') : b.text
			if (!seen.has(l.href)) seen.set(l.href, text.slice(l.start, l.end))
		}
	}
	return [...seen].map(([href, label]) => ({ href, label }))
}

type Page = 'main' | 'links' | 'bucket' | 'next' | 'notes' | 'more'

/** One tappable line of the sheet: a label (with a detail under it), its value, and a chevron. */
function SheetRow({ label, detail, value, onPress, danger }: { label: string; detail?: string; value?: string; onPress(): void; danger?: boolean }) {
	const c = useColors()
	return (
		<Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => ({ paddingVertical: 14, borderTopWidth: hairline, borderColor: c.ring, opacity: pressed ? 0.6 : 1 })}>
			<Row>
				<Group gap={2} style={{ flexShrink: detail ? 1 : 0 }}>
					<Text style={danger ? { color: '#C62828' } : undefined}>{label}</Text>
					{detail ? (
						<Text variant="muted" numberOfLines={1}>
							{detail}
						</Text>
					) : null}
				</Group>
				<Row style={{ flexShrink: detail ? 0 : 1, gap: space.xs }}>
					{value ? (
						<Text variant="muted" numberOfLines={1} style={{ flexShrink: detail ? 0 : 1, textAlign: 'right' }}>
							{value}
						</Text>
					) : null}
					<Ionicons name="chevron-forward" size={16} color={c.sub} />
				</Row>
			</Row>
		</Pressable>
	)
}

function Back({ title, onPress }: { title: string; onPress(): void }) {
	const c = useColors()
	return (
		<Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={onPress} hitSlop={8}>
			<Row style={{ justifyContent: 'flex-start', gap: space.xs }}>
				<Ionicons name="chevron-back" size={20} color={c.fg} />
				<Text variant="heading">{title}</Text>
			</Row>
		</Pressable>
	)
}

/**
 * Everything a reading offers besides its text, opened from the pill at the bottom of the reader:
 * tests, teaching back, focus sessions, what to read next, the pages it links to, its bucket, and
 * rarely used actions. Keeping them here leaves the page itself for reading.
 */
export function ReadingSheet({
	visible,
	onClose,
	item,
	current,
	total,
	focus,
	inSession,
	next,
	links,
	linked,
	explanations,
	onOpenLink,
}: {
	visible: boolean
	onClose(): void
	item: Item
	/** The section on screen, from 1. */
	current: number
	total: number
	/** The focus session controls: durations and Start, or the running session. */
	focus: ReactNode
	inSession: boolean
	next: { id: string; title: string } | null
	links: LinkedResource[]
	/** Linked pages that are already readings: address → reading id. */
	linked: Record<string, string>
	explanations: Extract<Note, { kind: 'explanation' }>[]
	/** A linked page that is not a reading yet was picked: offer to import or open it. */
	onOpenLink(href: string): void
}) {
	const c = useColors()
	const router = useRouter()
	const queryClient = useQueryClient()
	const [page, setPage] = useState<Page>('main')
	const [confirming, setConfirming] = useState(false)
	const library = useQuery({ queryKey: ['items'], queryFn: api.items, enabled: visible })
	const refresh = () => {
		queryClient.invalidateQueries({ queryKey: ['items'] })
		queryClient.invalidateQueries({ queryKey: ['item', item.id] })
	}
	const move = useMutation({ mutationFn: (collectionId: string | null) => api.moveItem(item.id, collectionId), onSettled: refresh })
	const setNext = useMutation({ mutationFn: (nextId: string) => api.setNext(item.id, nextId), onSuccess: () => setPage('main'), onSettled: refresh })
	const deleteNote = useMutation({ mutationFn: api.deleteNote, onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notes', item.id] }) })
	const remove = useMutation({
		mutationFn: () => api.deleteItem(item.id),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ['items'] })
			close()
			router.back()
		},
	})

	const close = () => {
		setPage('main')
		setConfirming(false)
		onClose()
	}
	const go = (path: Href) => {
		close()
		router.push(path)
	}
	const bucket = library.data?.collections.find((b) => b.id === item.collectionId)
	const imported = links.filter((l) => linked[l.href]).length

	let body: ReactNode
	if (page === 'links')
		body = (
			<>
				<Back title="Linked resources" onPress={() => setPage('main')} />
				<Text variant="muted">Pages this reading links to. Import one to read and be tested on it here; it is kept inside this reading.</Text>
				{links.map((l) => (
					<SheetRow
						key={l.href}
						label={l.label || shortUrl(l.href)}
						detail={shortUrl(l.href)}
						value={linked[l.href] ? 'Imported' : undefined}
						onPress={() => {
							const saved = linked[l.href]
							if (saved) return go(`/read/${saved}`)
							close()
							onOpenLink(l.href)
						}}
					/>
				))}
			</>
		)
	else if (page === 'bucket')
		body = (
			<>
				<Back title="Bucket" onPress={() => setPage('main')} />
				<BucketPicker value={item.collectionId} onChange={(id) => move.mutate(id)} />
				<ErrorText error={move.error} />
			</>
		)
	else if (page === 'next') {
		const others = (library.data?.items ?? []).filter((i) => i.id !== item.id)
		body = (
			<>
				<Back title="What comes next" onPress={() => setPage('main')} />
				<Text variant="muted">
					{bucket
						? `The reading you pick moves into “${bucket.name}”, right after this one.`
						: 'This reading and the one you pick go into a new bucket, named after this reading, in that order.'}{' '}
					Change the order any time in the Library.
				</Text>
				{others.map((i) => (
					<SheetRow key={i.id} label={i.title} value={i.id === next?.id ? 'Next' : undefined} onPress={() => setNext.mutate(i.id)} />
				))}
				{!others.length && <Text variant="muted">Add another reading to your library first.</Text>}
				<ErrorText error={setNext.error} />
			</>
		)
	} else if (page === 'notes')
		body = (
			<>
				<Back title="Your explanations" onPress={() => setPage('main')} />
				{explanations.map((n) => (
					<Group key={n.id} gap={space.md} style={{ paddingTop: space.md, borderTopWidth: hairline, borderColor: c.ring }}>
						<Passage text={n.passage ?? ''} />
						<ExplanationView note={n} />
						<Pressable accessibilityRole="button" onPress={() => deleteNote.mutate(n.id)} hitSlop={8} style={{ alignSelf: 'flex-start' }}>
							<Text variant="muted">Delete</Text>
						</Pressable>
					</Group>
				))}
			</>
		)
	else if (page === 'more')
		body = confirming ? (
			<>
				<Back title="Delete this reading?" onPress={() => setConfirming(false)} />
				<Text variant="muted">Its text, questions, review history, explanations, notes and the words picked up from it are deleted. This cannot be undone.</Text>
				<Row style={{ gap: space.sm }}>
					<Button title="Keep it" kind="outline" onPress={() => setConfirming(false)} style={{ flex: 1 }} />
					<Button title="Delete" onPress={() => remove.mutate()} loading={remove.isPending} style={{ flex: 1 }} />
				</Row>
				<ErrorText error={remove.error} />
			</>
		) : (
			<>
				<Back title="More" onPress={() => setPage('main')} />
				<SheetRow
					label="Manage test"
					value={item.questionIntensity && item.questionStyle ? settingsLabel(item.questionIntensity, item.questionStyle) : undefined}
					onPress={() => go(`/manage/${item.id}`)}
				/>
				<SheetRow label="Delete from library" danger onPress={() => setConfirming(true)} />
			</>
		)
	else
		body = (
			<>
				<Group gap={space.xs}>
					<Progress value={total ? current / total : 0} />
					<Text variant="muted">
						Section {current} of {total}
					</Text>
				</Group>
				{!inSession && (
					<Row style={{ gap: space.sm }}>
						<Button title="Test me" onPress={() => go(`/test/${item.id}`)} style={{ flex: 1 }} />
						<Button title="Teach it back" kind="outline" onPress={() => go(`/teach/${item.id}`)} style={{ flex: 1 }} />
					</Row>
				)}
				{focus}
				<View>
					<SheetRow label="Up next" value={next?.title ?? 'Choose'} onPress={() => (next ? go(`/read/${next.id}`) : setPage('next'))} />
					{next && <SheetRow label="Change what comes next" onPress={() => setPage('next')} />}
					{links.length > 0 && <SheetRow label="Linked resources" value={imported ? `${links.length} · ${imported} imported` : String(links.length)} onPress={() => setPage('links')} />}
					<SheetRow label="Bucket" value={bucket?.name ?? 'None'} onPress={() => setPage('bucket')} />
					{explanations.length > 0 && <SheetRow label="Your explanations" value={String(explanations.length)} onPress={() => setPage('notes')} />}
					<SheetRow label="More" value="Manage test, delete" onPress={() => setPage('more')} />
				</View>
				<Text variant="muted">{Platform.OS === 'web' ? 'Select any text to have it explained.' : 'Long-press a paragraph to have it explained.'}</Text>
			</>
		)

	return (
		<Sheet visible={visible} onClose={close}>
			{body}
		</Sheet>
	)
}
