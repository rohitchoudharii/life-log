import Ionicons from '@expo/vector-icons/Ionicons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useFocusEffect, useRouter } from 'expo-router'
import { useCallback, useState } from 'react'
import { Pressable, View } from 'react-native'
import { api, type Collection, type ItemSummary } from '@/api'
import { space, useColors } from '@/theme'
import { Button, ErrorText, Group, Loading, Row, Screen, Text, Tile } from '@/ui'

const statusLabel: Record<ItemSummary['status'], string> = {
	processing: 'Writing questions…',
	ready: '',
	needs_key: 'Waiting for your AI key',
	failed: 'Question writing failed',
}

const sourceLabel = (item: ItemSummary) => (item.sourceUrl ? new URL(item.sourceUrl).hostname.replace(/^www\./, '') : null)

function ItemTile({ item, order }: { item: ItemSummary; order?: { up?(): void; down?(): void; position: number } }) {
	const router = useRouter()
	const c = useColors()
	const queryClient = useQueryClient()
	const source = sourceLabel(item)
	// Deleting asks once, on the tile itself, since it takes the questions and review history with it.
	const [confirming, setConfirming] = useState(false)
	const remove = useMutation({
		mutationFn: () => api.deleteItem(item.id),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ['items'] })
			queryClient.invalidateQueries({ queryKey: ['today'] })
			queryClient.invalidateQueries({ queryKey: ['due'] })
		},
	})
	if (confirming)
		return (
			<Tile style={{ gap: space.md }}>
				<Text>Delete “{item.title}”?</Text>
				<Text variant="muted">Its questions, review history and explanations are deleted too. Words you learned from it stay in your vocabulary.</Text>
				<Row style={{ gap: space.sm }}>
					<Button title="Keep it" kind="outline" onPress={() => setConfirming(false)} style={{ flex: 1 }} />
					<Button title="Delete" onPress={() => remove.mutate()} loading={remove.isPending} style={{ flex: 1 }} />
				</Row>
				<ErrorText error={remove.error} />
			</Tile>
		)
	const tile = (
		<Tile onPress={order ? undefined : () => router.push(`/read/${item.id}`)}>
			<Row style={{ alignItems: 'flex-start' }}>
				<Text style={{ flex: 1, paddingRight: order ? 0 : 28 }}>
					{order ? `${order.position + 1}. ` : ''}
					{item.title}
				</Text>
				{order && (
					<Row style={{ gap: space.md }}>
						{(['up', 'down'] as const).map((dir) => (
							<Pressable
								key={dir}
								accessibilityRole="button"
								accessibilityLabel={`Move ${item.title} ${dir}`}
								disabled={!order[dir]}
								onPress={order[dir]}
								hitSlop={8}
							>
								<Ionicons name={dir === 'up' ? 'arrow-up' : 'arrow-down'} size={20} color={order[dir] ? c.fg : c.ring} />
							</Pressable>
						))}
					</Row>
				)}
			</Row>
			<Row>
				<Text variant="muted" style={{ flex: 1 }}>
					{source ? `${source} · ` : ''}
					{item.sectionCount} section{item.sectionCount === 1 ? '' : 's'}, {item.questionCount} question{item.questionCount === 1 ? '' : 's'}
					{item.ideaCount ? `, ${item.ideasLearned} of ${item.ideaCount} ideas learned` : ''}
				</Text>
				{statusLabel[item.status] ? <Text variant="muted">{statusLabel[item.status]}</Text> : null}
			</Row>
		</Tile>
	)
	if (order) return tile
	// Beside the tile, not inside it: a button inside the tile's button is invalid on the web.
	return (
		<View>
			{tile}
			<Pressable
				accessibilityRole="button"
				accessibilityLabel={`Delete ${item.title}`}
				onPress={() => setConfirming(true)}
				hitSlop={8}
				style={{ position: 'absolute', top: 12, right: space.md, padding: space.xs }}
			>
				<Ionicons name="trash-outline" size={18} color={c.sub} />
			</Pressable>
		</View>
	)
}

function Bucket({ bucket, items }: { bucket: Collection; items: ItemSummary[] }) {
	const queryClient = useQueryClient()
	const [editing, setEditing] = useState(false)
	const order = useMutation({
		mutationFn: (ids: string[]) => api.orderCollection(bucket.id, ids),
		onMutate: (ids) =>
			queryClient.setQueryData<Awaited<ReturnType<typeof api.items>>>(['items'], (d) =>
				d && { ...d, items: d.items.map((i) => (ids.includes(i.id) ? { ...i, collectionPosition: ids.indexOf(i.id) } : i)) },
			),
		onSettled: () => queryClient.invalidateQueries({ queryKey: ['items'] }),
	})
	const remove = useMutation({ mutationFn: () => api.deleteCollection(bucket.id), onSettled: () => queryClient.invalidateQueries({ queryKey: ['items'] }) })
	const move = (from: number, to: number) => {
		const ids = items.map((i) => i.id)
		;[ids[from], ids[to]] = [ids[to]!, ids[from]!]
		order.mutate(ids)
	}
	return (
		<Group gap={10}>
			<Row>
				<Group gap={2} style={{ flex: 1 }}>
					<Text variant="label">{bucket.name}</Text>
					<Text variant="muted">
						{items.length} page{items.length === 1 ? '' : 's'}
					</Text>
				</Group>
				{editing && !items.length ? (
					<Button title="Delete bucket" kind="outline" onPress={() => remove.mutate()} loading={remove.isPending} />
				) : null}
				<Button title={editing ? 'Done' : 'Edit order'} kind="outline" onPress={() => setEditing(!editing)} />
			</Row>
			{!items.length && <Text variant="muted">No pages yet. Add a link or capture pages with the Chrome extension, and pick this bucket.</Text>}
			{items.map((item, i) => (
				<ItemTile
					key={item.id}
					item={item}
					order={editing ? { position: i, up: i > 0 ? () => move(i, i - 1) : undefined, down: i < items.length - 1 ? () => move(i, i + 1) : undefined } : undefined}
				/>
			))}
			<ErrorText error={order.error ?? remove.error} />
		</Group>
	)
}

export default function Library() {
	const router = useRouter()
	const items = useQuery({
		queryKey: ['items'],
		queryFn: api.items,
		// Poll while questions are still being written.
		refetchInterval: (q) => (q.state.data?.items.some((i) => i.status === 'processing') ? 3000 : false),
	})
	const { refetch } = items
	useFocusEffect(useCallback(() => void refetch(), [refetch]))

	if (items.isPending) return <Loading />
	const all = items.data?.items ?? []
	const loose = all.filter((i) => !i.collectionId)
	return (
		<Screen footer={<Button title="Add to library" onPress={() => router.push('/add')} />}>
			<Group>
				<Text variant="title">Library</Text>
				<Text variant="muted">Everything you are learning from</Text>
			</Group>
			<ErrorText error={items.error} />
			{all.length === 0 && <Text variant="muted">Nothing here yet. Paste a link or some text you want to learn.</Text>}
			{items.data?.collections.map((b) => (
				<Bucket
					key={b.id}
					bucket={b}
					items={all.filter((i) => i.collectionId === b.id).sort((x, y) => (x.collectionPosition ?? 0) - (y.collectionPosition ?? 0))}
				/>
			))}
			{loose.length > 0 && (
				<Group gap={10}>
					{items.data?.collections.length ? <Text variant="label">Other readings</Text> : null}
					{loose.map((item) => (
						<ItemTile key={item.id} item={item} />
					))}
				</Group>
			)}
		</Screen>
	)
}
