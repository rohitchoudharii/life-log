import Ionicons from '@expo/vector-icons/Ionicons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useFocusEffect, useRouter } from 'expo-router'
import { useCallback, useRef, useState, type ComponentProps, type ComponentRef } from 'react'
import { Modal, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native'
import { api, type Collection, type ItemSummary } from '@/api'
import { hairline, radius, space, useColors } from '@/theme'
import { Button, ErrorText, Group, Loading, Row, Screen, Sheet, Text } from '@/ui'

/** Questions are written in the background, only when asked for in Manage test. */
const statusLabel: Record<ItemSummary['status'], string> = {
	processing: 'Writing questions…',
	ready: '',
	needs_key: 'Waiting for your AI key',
	failed: 'Could not write questions',
}

const sourceLabel = (item: ItemSummary) => (item.sourceUrl ? new URL(item.sourceUrl).hostname.replace(/^www\./, '') : null)

/** When a reading was last opened, or added if it never was. */
const accessed = (item: ItemSummary) => Date.parse(item.lastOpenedAt ?? item.createdAt)

const DANGER = '#C62828'

/**
 * The ⋯ menu on a reading: its practice, its quiz, and deleting it. It drops down under the
 * button; Delete asks first, in a sheet.
 */
function ReadingMenu({ item }: { item: ItemSummary }) {
	const router = useRouter()
	const c = useColors()
	const queryClient = useQueryClient()
	const { width } = useWindowDimensions()
	const anchor = useRef<ComponentRef<typeof Pressable>>(null)
	const [at, setAt] = useState<{ top: number; right: number } | null>(null)
	const [confirming, setConfirming] = useState(false)
	const remove = useMutation({
		mutationFn: () => api.deleteItem(item.id),
		onSuccess: () => {
			setConfirming(false)
			queryClient.invalidateQueries({ queryKey: ['items'] })
			queryClient.invalidateQueries({ queryKey: ['today'] })
		},
	})
	const open = () =>
		anchor.current?.measureInWindow((x, y, w, h) => setAt({ top: y + h + space.xs, right: Math.max(space.sm, width - x - w) }))
	const pick = (action: () => void) => () => {
		setAt(null)
		action()
	}
	const entry = (label: string, icon: ComponentProps<typeof Ionicons>['name'], onPress: () => void, hint?: string, danger?: boolean) => (
		<Pressable
			accessibilityRole="menuitem"
			onPress={pick(onPress)}
			style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: 12, paddingHorizontal: space.lg, backgroundColor: pressed ? c.track : 'transparent' })}
		>
			<Ionicons name={icon} size={18} color={danger ? DANGER : c.fg} />
			<Text style={{ flex: 1, color: danger ? DANGER : c.fg }}>{label}</Text>
			{hint ? <Text variant="muted">{hint}</Text> : null}
		</Pressable>
	)
	return (
		<>
			<Pressable
				ref={anchor}
				accessibilityRole="button"
				accessibilityLabel={`Options for ${item.title}`}
				accessibilityState={{ expanded: Boolean(at) }}
				onPress={open}
				hitSlop={8}
				style={({ pressed }) => ({ width: 32, height: 32, borderRadius: radius, alignItems: 'center', justifyContent: 'center', backgroundColor: at || pressed ? c.track : 'transparent' })}
			>
				<Ionicons name="ellipsis-horizontal" size={18} color={c.sub} />
			</Pressable>
			<Modal visible={Boolean(at)} transparent animationType="fade" onRequestClose={() => setAt(null)}>
				<Pressable accessibilityLabel="Close menu" onPress={() => setAt(null)} style={StyleSheet.absoluteFill} />
				{at && (
					<View
						accessibilityRole="menu"
						style={{
							position: 'absolute',
							top: at.top,
							right: at.right,
							minWidth: 230,
							paddingVertical: space.xs,
							borderRadius: 12,
							borderWidth: hairline,
							borderColor: c.ring,
							backgroundColor: c.bg,
							shadowColor: '#000',
							shadowOpacity: 0.16,
							shadowRadius: 12,
							shadowOffset: { width: 0, height: 4 },
							elevation: 6,
						}}
					>
						{entry('Take test', 'play-outline', () => router.push({ pathname: '/test/[id]', params: { id: item.id } }))}
						{entry('Teach it back', 'chatbubble-outline', () => router.push({ pathname: '/teach/[id]', params: { id: item.id } }))}
						{entry(
							'Manage test',
							'options-outline',
							() => router.push({ pathname: '/manage/[id]', params: { id: item.id } }),
							item.questionCount ? `${item.questionCount} questions` : 'No quiz',
						)}
						<View style={{ height: hairline, backgroundColor: c.ring, marginVertical: space.xs }} />
						{entry('Delete', 'trash-outline', () => setConfirming(true), undefined, true)}
					</View>
				)}
			</Modal>
			<Sheet visible={confirming} onClose={() => setConfirming(false)}>
				<Group gap={space.xs}>
					<Text variant="heading">Delete “{item.title}”?</Text>
					<Text variant="muted">
						Its text, questions, review history, explanations, notes and the words picked up from it are deleted. This cannot be undone.
					</Text>
				</Group>
				<Row style={{ gap: space.sm }}>
					<Button title="Keep it" kind="outline" onPress={() => setConfirming(false)} style={{ flex: 1 }} />
					<Button title="Delete" onPress={() => remove.mutate()} loading={remove.isPending} style={{ flex: 1 }} />
				</Row>
				<ErrorText error={remove.error} />
			</Sheet>
		</>
	)
}

function ItemRow({ item, order, nested = 0, indent = false }: { item: ItemSummary; order?: { up?(): void; down?(): void; position: number }; nested?: number; indent?: boolean }) {
	const router = useRouter()
	const c = useColors()
	const meta = [
		sourceLabel(item),
		item.ideaCount ? `${item.ideasLearned}/${item.ideaCount} ideas learned` : null,
		nested ? `${nested} linked` : null,
		statusLabel[item.status] || null,
	].filter(Boolean)
	return (
		<Pressable
			onPress={order ? undefined : () => router.push(`/read/${item.id}`)}
			style={({ pressed }) => ({ paddingVertical: 10, paddingLeft: indent ? 26 : 0, borderBottomWidth: hairline, borderColor: c.track, opacity: pressed ? 0.6 : 1 })}
		>
			<Row>
				<View style={{ flex: 1, gap: 2 }}>
					<Text numberOfLines={1}>
						{order ? `${order.position + 1}. ` : ''}
						{item.title}
					</Text>
					{meta.length ? (
						<Text variant="muted" numberOfLines={1} style={{ fontSize: 12, lineHeight: 16 }}>
							{meta.join(' · ')}
						</Text>
					) : null}
				</View>
				{!order && <ReadingMenu item={item} />}
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
		</Pressable>
	)
}

/** A bucket shows only its name and count until it is opened; inside, pages keep their own order. */
function Bucket({ bucket, items, nested }: { bucket: Collection; items: ItemSummary[]; nested(id: string): number }) {
	const c = useColors()
	const queryClient = useQueryClient()
	const [open, setOpen] = useState(false)
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
	const action = (title: string, onPress: () => void) => (
		<Pressable accessibilityRole="button" onPress={onPress} hitSlop={8}>
			<Text variant="muted" style={{ textDecorationLine: 'underline' }}>
				{title}
			</Text>
		</Pressable>
	)
	return (
		<View>
			<Pressable
				accessibilityRole="button"
				accessibilityState={{ expanded: open }}
				onPress={() => {
					setOpen(!open)
					setEditing(false)
				}}
				style={({ pressed }) => ({ paddingVertical: 12, borderBottomWidth: hairline, borderColor: c.track, opacity: pressed ? 0.6 : 1 })}
			>
				<Row>
					<Ionicons name={open ? 'chevron-down' : 'chevron-forward'} size={16} color={c.sub} />
					<Text numberOfLines={1} style={{ flex: 1, color: items.length ? c.fg : c.sub }}>
						{bucket.name}
					</Text>
					<Text variant="muted" style={{ fontVariant: ['tabular-nums'] }}>
						{items.length}
					</Text>
				</Row>
			</Pressable>
			{open && (
				<View>
					{items.map((item, i) => (
						<ItemRow
							key={item.id}
							item={item}
							indent
							nested={nested(item.id)}
							order={editing ? { position: i, up: i > 0 ? () => move(i, i - 1) : undefined, down: i < items.length - 1 ? () => move(i, i + 1) : undefined } : undefined}
						/>
					))}
					{items.length !== 1 && (
						<Row style={{ justifyContent: 'flex-start', gap: space.lg, paddingLeft: 26, paddingVertical: space.sm }}>
							{items.length ? (
								action(editing ? 'Done' : 'Edit order', () => setEditing(!editing))
							) : (
								<>
									<Text variant="muted">No pages yet</Text>
									{action('Delete bucket', () => remove.mutate())}
								</>
							)}
						</Row>
					)}
					<ErrorText error={order.error ?? remove.error} />
				</View>
			)}
		</View>
	)
}

export default function Library() {
	const router = useRouter()
	const c = useColors()
	const items = useQuery({
		queryKey: ['items'],
		queryFn: api.items,
		// Poll while questions are still being written.
		refetchInterval: (q) => (q.state.data?.items.some((i) => i.status === 'processing') ? 3000 : false),
	})
	const { refetch } = items
	useFocusEffect(useCallback(() => void refetch(), [refetch]))

	if (items.isPending) return <Loading />
	// Pages imported from a reading's links are listed inside it, not here.
	const every = items.data?.items ?? []
	const ids = new Set(every.map((i) => i.id))
	const all = every.filter((i) => !i.parentId || !ids.has(i.parentId))
	const nested = (id: string) => every.filter((i) => i.parentId === id).length
	// Buckets and loose readings share one list, most recently opened first; a bucket counts as opened when any of its pages was.
	const entries = [
		...(items.data?.collections ?? []).map((bucket) => {
			const inside = all.filter((i) => i.collectionId === bucket.id).sort((x, y) => (x.collectionPosition ?? 0) - (y.collectionPosition ?? 0))
			return { key: bucket.id, at: Math.max(0, ...inside.map(accessed)), node: <Bucket bucket={bucket} items={inside} nested={nested} /> }
		}),
		...all
			.filter((i) => !i.collectionId)
			.map((item) => ({ key: item.id, at: accessed(item), node: <ItemRow item={item} nested={nested(item.id)} /> })),
	].sort((x, y) => y.at - x.at)
	return (
		<Screen>
			<Row>
				<Text variant="title">Library</Text>
				<Pressable
					accessibilityRole="button"
					accessibilityLabel="Add to library"
					onPress={() => router.push('/add')}
					hitSlop={8}
					style={({ pressed }) => ({ width: 34, height: 34, borderRadius: 17, backgroundColor: c.fg, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.7 : 1 })}
				>
					<Ionicons name="add" size={20} color={c.bg} />
				</Pressable>
			</Row>
			<ErrorText error={items.error} />
			{entries.length === 0 && <Text variant="muted">Nothing here yet. Tap + to add a link or some text you want to learn.</Text>}
			<View>
				{entries.map((e) => (
					<View key={e.key}>{e.node}</View>
				))}
			</View>
		</Screen>
	)
}
