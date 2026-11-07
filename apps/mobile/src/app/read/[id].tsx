import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router'
import { blockText } from '@life-log-club/core'
import Ionicons from '@expo/vector-icons/Ionicons'
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentRef } from 'react'
import { Linking, Platform, Pressable, ScrollView, View } from 'react-native'
import { api, type ExplainKind, type ExplainLevel, type Me, type Note, type Section, type StudySession } from '@/api'
import { BlockView } from '@/blocks'
import { ExplainSheet, type ExplainRequest } from '@/explain-sheet'
import { sentenceWith } from '@/notes'
import { linkedResources, ReadingSheet, shortUrl } from '@/reading-sheet'
import { cancelSessionEnd, scheduleSessionEnd } from '@/reminders'
import { font, hairline, space, useColors } from '@/theme'
import { Button, Choice, ChoiceRow, ErrorText, Group, Loading, Row, Sheet, Text } from '@/ui'
import { formatClock, useNow } from '@/useNow'

const DURATIONS = [15, 25, 45]
/** The clock stays hidden so it does not pull attention, until the last seconds. */
const SHOW_CLOCK_MS = 15_000

const squash = (text: string) => text.replace(/\s+/g, ' ').trim()

/**
 * On the web, text selected in the reader, with the section it is in, so it can be explained.
 * A selection across sections belongs to the section it starts in.
 */
function useWebSelection(sections: Section[] | undefined) {
	const [selection, setSelection] = useState<{ text: string; sectionId: string } | null>(null)
	useEffect(() => {
		if (Platform.OS !== 'web' || !sections) return
		const texts = sections.map((s) => ({ id: s.id, text: squash(s.blocks.map(blockText).join(' ')) }))
		const onChange = () => {
			const text = squash(window.getSelection()?.toString() ?? '')
			const start = text.slice(0, 40)
			const section = text.length >= 3 ? texts.find((s) => s.text.includes(start)) : undefined
			setSelection(section ? { text, sectionId: section.id } : null)
		}
		document.addEventListener('selectionchange', onChange)
		return () => document.removeEventListener('selectionchange', onChange)
	}, [sections])
	return selection
}

/**
 * What a tapped link can do: open the page in the browser, or import it as a reading nested under
 * this one. A page that is already a reading opens it instead of importing it again.
 */
function LinkSheet({ itemId, href, saved, onClose }: { itemId: string; href: string | null; saved?: string; onClose(): void }) {
	const router = useRouter()
	const queryClient = useQueryClient()
	const importLink = useMutation({
		mutationFn: (url: string) => api.importLink(itemId, url),
		onSuccess: ({ item }) => {
			queryClient.invalidateQueries({ queryKey: ['items'] })
			queryClient.invalidateQueries({ queryKey: ['item', itemId] })
			close()
			router.push(`/read/${item.id}`)
		},
	})
	const close = () => {
		importLink.reset()
		onClose()
	}
	return (
		<Sheet visible={href !== null} onClose={close}>
					<Text variant="muted" numberOfLines={2}>
						{href ? shortUrl(href) : ''}
					</Text>
					{saved ? (
						<Button
							title="Open reading"
							onPress={() => {
								close()
								router.push(`/read/${saved}`)
							}}
						/>
					) : (
						<Button title={importLink.isPending ? 'Importing the page…' : 'Import as reading'} onPress={() => href && importLink.mutate(href)} loading={importLink.isPending} />
					)}
					<Button
						title="Open link"
						kind="outline"
						onPress={() => {
							if (href) Linking.openURL(href)
							close()
						}}
					/>
					<ErrorText error={importLink.error} />
		</Sheet>
	)
}

const LEVELS: { value: ExplainLevel; label: string; short: string }[] = [
	{ value: 'new', label: 'New to this', short: 'New' },
	{ value: 'standard', label: 'Standard', short: 'Standard' },
	{ value: 'expert', label: 'Expert', short: 'Expert' },
]

/** One action in the reader's bottom pill. */
function PillAction({ label, icon, accessibilityLabel, onPress }: { label?: string; icon?: 'close'; accessibilityLabel?: string; onPress(): void }) {
	const c = useColors()
	return (
		<Pressable
			accessibilityRole="button"
			accessibilityLabel={accessibilityLabel ?? label}
			onPress={onPress}
			style={({ pressed }) => ({ paddingVertical: 12, paddingHorizontal: space.md, opacity: pressed ? 0.6 : 1 })}
		>
			{icon ? <Ionicons name={icon} size={18} color={c.bg} /> : <Text style={{ color: c.bg, fontFamily: font.semibold }}>{label}</Text>}
		</Pressable>
	)
}

const headingStyle = (level: number) =>
	level === 1
		? { fontSize: 22, lineHeight: 28 }
		: level === 2
			? { fontSize: 18, lineHeight: 25 }
			: { fontSize: 16, lineHeight: 23 }

export default function Reader() {
	const { id } = useLocalSearchParams<{ id: string }>()
	const router = useRouter()
	const c = useColors()
	const queryClient = useQueryClient()
	const data = useQuery({
		queryKey: ['item', id],
		queryFn: () => api.item(id),
		refetchInterval: (q) => (q.state.data?.item.status === 'processing' || q.state.data?.item.linksImport === 'importing' ? 3000 : false),
	})
	const { refetch } = data
	const notes = useQuery({ queryKey: ['notes', id], queryFn: () => api.notes(id) })
	const refetchNotes = notes.refetch
	useFocusEffect(useCallback(() => void (refetch(), refetchNotes()), [refetch, refetchNotes]))
	const selection = useWebSelection(data.data?.sections)
	// On phones, the paragraph long-pressed; the pill acts on it until it is closed.
	const [pressed, setPressed] = useState<{ text: string; sectionId: string; block: number } | null>(null)
	const target = selection ?? pressed
	// Who explanations are written for; picking a level saves it as the user's setting.
	const me = useQuery({ queryKey: ['me'], queryFn: api.me })
	const level = me.data?.explainLevel ?? 'standard'
	const [levelMenu, setLevelMenu] = useState(false)
	const [explaining, setExplaining] = useState<ExplainRequest | null>(null)
	// On the web, a click would clear the selected text, and with it the pill; clicks on the pill keep it.
	const pillRef = useRef<ComponentRef<typeof View>>(null)
	const hasTarget = Boolean(target)
	useEffect(() => {
		const el = pillRef.current as unknown as HTMLElement | null
		if (Platform.OS !== 'web' || !el) return
		const keep = (e: MouseEvent) => e.preventDefault()
		el.addEventListener('mousedown', keep)
		return () => el.removeEventListener('mousedown', keep)
	}, [hasTarget])
	useEffect(() => {
		if (!hasTarget) setLevelMenu(false)
	}, [hasTarget])
	const setLevel = useMutation({
		mutationFn: (explainLevel: ExplainLevel) => api.updateMe({ explainLevel }),
		onMutate: (explainLevel) => {
			queryClient.setQueryData(['me'], (old: Me | undefined) => old && { ...old, explainLevel })
			setLevelMenu(false)
		},
		onSuccess: (next) => queryClient.setQueryData(['me'], next),
	})
	const addWord = useMutation({
		mutationFn: (sel: { text: string; sectionId: string }) => {
			const s = data.data!.sections.find((x) => x.id === sel.sectionId)!
			return api.addWord({ word: sel.text, sentence: sentenceWith(s.blocks.map(blockText).join(' '), sel.text), itemId: id })
		},
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['words'] }),
	})
	const explanations = (notes.data?.notes ?? []).filter((n): n is Extract<Note, { kind: 'explanation' }> => n.kind === 'explanation')

	const [link, setLink] = useState<string | null>(null)
	const [sheetOpen, setSheetOpen] = useState(false)
	// The section on screen: the last one whose top is above a third of the way down the screen.
	const tops = useRef<number[]>([])
	const [current, setCurrent] = useState(0)
	const links = useMemo(() => linkedResources(data.data?.sections.flatMap((s) => s.blocks) ?? []), [data.data?.sections])
	const [minutes, setMinutes] = useState(25)
	const session = data.data?.activeSession ?? null
	const now = useNow(Boolean(session))
	const endsAt = session ? new Date(session.startedAt).getTime() + session.plannedMinutes * 60_000 : 0
	const timeUp = Boolean(session) && now >= endsAt

	const setSession = (s: StudySession | null) =>
		queryClient.setQueryData(['item', id], (old: typeof data.data) => old && { ...old, activeSession: s })

	const start = useMutation({
		mutationFn: () => api.startSession(id, minutes),
		onSuccess: ({ session: s }) => {
			setSession(s)
			scheduleSessionEnd(new Date(new Date(s.startedAt).getTime() + s.plannedMinutes * 60_000))
		},
	})
	const finish = useMutation({
		mutationFn: () => api.finishSession(session!.id),
		onSuccess: () => {
			cancelSessionEnd()
			setSession(null)
			queryClient.invalidateQueries({ queryKey: ['today'] })
			router.push({ pathname: '/test/[id]', params: { id, afterSession: '1' } })
		},
	})
	const cancel = useMutation({
		mutationFn: () => api.cancelSession(session!.id),
		onSuccess: () => {
			cancelSessionEnd()
			setSession(null)
		},
	})

	// When the focus block ends, go straight to picking what to be tested on.
	const ended = useRef<string | null>(null)
	const { mutate: finishSession } = finish
	useEffect(() => {
		if (session && timeUp && ended.current !== session.id) {
			ended.current = session.id
			finishSession()
		}
	}, [session, timeUp, finishSession])

	if (data.isPending) return <Loading />
	if (data.error) return <ErrorText error={data.error} />
	const { item, sections, linked, children, parent, next } = data.data
	const left = endsAt - now

	// Inside the sheet: the running session, or a duration and Start.
	const focus = session ? (
		<Group gap={space.md}>
			<Row>
				<Group gap={2}>
					<Text style={{ fontFamily: font.semibold, fontSize: 20, fontVariant: ['tabular-nums'] }}>
						{timeUp ? "Time's up" : left <= SHOW_CLOCK_MS ? formatClock(left) : 'Focusing'}
					</Text>
					<Text variant="muted">{session.plannedMinutes}-minute focus session</Text>
				</Group>
				<Pressable accessibilityRole="button" onPress={() => cancel.mutate()} hitSlop={8}>
					<Text variant="muted">Cancel</Text>
				</Pressable>
			</Row>
			<Button title="Stop and test me" onPress={() => finish.mutate()} loading={finish.isPending} />
			<ErrorText error={finish.error ?? cancel.error} />
		</Group>
	) : (
		<Group gap={space.xs}>
			<Text variant="label">Focus</Text>
			<Row style={{ gap: space.sm }}>
				<View style={{ flex: 3 }}>
					<ChoiceRow>
						{DURATIONS.map((m) => (
							<Choice key={m} label={`${m} min`} selected={minutes === m} onPress={() => setMinutes(m)} />
						))}
					</ChoiceRow>
				</View>
				<Button
					title="Start"
					kind="outline"
					onPress={() => start.mutate(undefined, { onSuccess: () => setSheetOpen(false) })}
					loading={start.isPending}
					style={{ flex: 1 }}
				/>
			</Row>
			<ErrorText error={start.error} />
		</Group>
	)
	const pillDivider = { width: hairline, height: 18, backgroundColor: c.bg, opacity: 0.3 }
	const explainTarget = (kind: ExplainKind) => {
		if (!target) return
		setExplaining({ sectionId: target.sectionId, passage: target.text.slice(0, 4000), kind })
		setPressed(null)
		setLevelMenu(false)
		if (Platform.OS === 'web') window.getSelection()?.removeAllRanges()
	}
	const pillLabel = session ? (timeUp ? "Time's up" : left <= SHOW_CLOCK_MS ? formatClock(left) : 'Focusing') : `Section ${current + 1} of ${sections.length}`

	return (
		<View style={{ flex: 1, backgroundColor: c.bg }}>
			<ScrollView
				scrollEventThrottle={100}
				onScroll={({ nativeEvent: e }) => {
					const atEnd = e.contentOffset.y + e.layoutMeasurement.height >= e.contentSize.height - 8
					const line = e.contentOffset.y + e.layoutMeasurement.height / 3
					const index = atEnd ? sections.length - 1 : Math.max(0, tops.current.filter((top) => top <= line).length - 1)
					if (index !== current) setCurrent(index)
				}}
				contentContainerStyle={{
					paddingHorizontal: space.screenX,
					paddingTop: space.xl,
					paddingBottom: 120,
					width: '100%',
					maxWidth: 680,
					alignSelf: 'center',
					gap: 36,
				}}
			>
				<Group gap={space.xs}>
					{parent && (
						<Pressable accessibilityRole="link" onPress={() => router.push(`/read/${parent.id}`)} hitSlop={8}>
							<Text variant="muted">From {parent.title}</Text>
						</Pressable>
					)}
					<Text variant="title">{item.title}</Text>
				</Group>
				{item.linksImport === 'importing' && <Text variant="muted">Importing the pages this links to: {children.length} so far. Pages that need a sign-in are skipped.</Text>}
				{item.status === 'needs_key' && <Text variant="muted">Connect your AI in Settings so it can write questions for this.</Text>}
				{sections.map((s, i) => (
					<View
						key={s.id}
						style={{ gap: space.lg }}
						onLayout={(e) => {
							tops.current[i] = e.nativeEvent.layout.y
						}}
					>
						{/* Text before the first heading is named after the reading; its title is already shown. */}
						{!(i === 0 && s.title === item.title) && (
							<Text variant="heading" style={headingStyle(s.level)}>
								{s.title}
							</Text>
						)}
						{s.blocks.map((b, j) =>
							// Phones explain a block on long-press; the web explains selected text instead, so dragging to select stays free.
							Platform.OS === 'web' || b.type === 'image' || b.type === 'page' ? (
								<BlockView key={j} block={b} onLink={setLink} />
							) : (
								<Pressable
									key={j}
									onLongPress={() => setPressed({ text: blockText(b), sectionId: s.id, block: j })}
									accessibilityHint="Long-press to have it explained"
									style={pressed?.sectionId === s.id && pressed.block === j ? { backgroundColor: c.ring, borderRadius: 6 } : undefined}
								>
									<BlockView block={b} selectable={false} onLink={setLink} />
								</Pressable>
							),
						)}
					</View>
				))}
				{/* The end of the reading offers only the next steps; everything else is in the sheet. */}
				<Group gap={space.md} style={{ paddingTop: space.xl, borderTopWidth: hairline, borderColor: c.ring }}>
					<Text variant="heading">You reached the end</Text>
					<Row style={{ gap: space.sm }}>
						<Button title="Test me" onPress={() => router.push({ pathname: '/test/[id]', params: { id } })} style={{ flex: 1 }} />
						<Button title="Teach it back" kind="outline" onPress={() => router.push({ pathname: '/teach/[id]', params: { id } })} style={{ flex: 1 }} />
					</Row>
					{next && (
						<Pressable
							accessibilityRole="button"
							onPress={() => router.push(`/read/${next.id}`)}
							style={({ pressed }) => ({ borderWidth: hairline, borderColor: pressed ? c.fg : c.ring, borderRadius: 12, padding: space.lg })}
						>
							<Row>
								<Text style={{ flexShrink: 1 }} numberOfLines={2}>
									<Text variant="muted">Up next · </Text>
									{next.title}
								</Text>
								<Ionicons name="chevron-forward" size={16} color={c.sub} />
							</Row>
						</Pressable>
					)}
				</Group>
			</ScrollView>
			{target ? (
				// Selected text or a long-pressed paragraph: each action explains it right away, at the level on the right.
				<View ref={pillRef} style={{ position: 'absolute', bottom: space.lg, alignSelf: 'center', alignItems: 'flex-end', gap: space.sm }}>
					{levelMenu && (
						<View style={{ borderRadius: 16, backgroundColor: c.fg, paddingVertical: space.xs, minWidth: 160 }}>
							{LEVELS.map((o) => (
								<Pressable
									key={o.value}
									accessibilityRole="menuitem"
									accessibilityState={{ selected: level === o.value }}
									onPress={() => setLevel.mutate(o.value)}
									style={({ pressed: down }) => ({ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md, paddingVertical: 10, paddingHorizontal: space.md, opacity: down ? 0.6 : 1 })}
								>
									<Text style={{ color: c.bg }}>{o.label}</Text>
									{level === o.value && <Ionicons name="checkmark" size={16} color={c.bg} />}
								</Pressable>
							))}
						</View>
					)}
					{/* A word or short term can go straight into the vocabulary, with the sentence it is in. */}
					{selection && selection.text.split(' ').length <= 3 && (
						<View style={{ borderRadius: 999, backgroundColor: c.fg }}>
							<PillAction
								label={addWord.isPending ? 'Adding…' : addWord.isError ? 'Try again' : addWord.isSuccess && addWord.variables?.text === selection.text ? 'Added' : 'Add word'}
								onPress={() => addWord.mutate(selection)}
							/>
						</View>
					)}
					<View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.xs, borderRadius: 999, backgroundColor: c.fg }}>
						<PillAction label="Explain" onPress={() => explainTarget('explain')} />
						<PillAction label="Analogy" onPress={() => explainTarget('analogy')} />
						<PillAction label="Example" onPress={() => explainTarget('example')} />
						<View style={pillDivider} />
						<Pressable
							accessibilityRole="button"
							accessibilityLabel={`Level: ${LEVELS.find((o) => o.value === level)?.label}. Change`}
							accessibilityState={{ expanded: levelMenu }}
							onPress={() => setLevelMenu(!levelMenu)}
							style={({ pressed: down }) => ({ flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 12, paddingHorizontal: space.md, opacity: down ? 0.6 : 1 })}
						>
							<Text style={{ color: c.bg, opacity: 0.75 }}>{LEVELS.find((o) => o.value === level)?.short}</Text>
							<Ionicons name={levelMenu ? 'chevron-down' : 'chevron-up'} size={14} color={c.bg} style={{ opacity: 0.75 }} />
						</Pressable>
						{pressed && !selection && (
							<>
								<View style={pillDivider} />
								<PillAction icon="close" accessibilityLabel="Close" onPress={() => setPressed(null)} />
							</>
						)}
					</View>
				</View>
			) : (
				// Always in reach without scrolling, and small, so the page keeps its space.
				<Pressable
					accessibilityRole="button"
					accessibilityLabel={`${pillLabel}. Open reading options`}
					onPress={() => setSheetOpen(true)}
					style={({ pressed }) => ({
						position: 'absolute',
						bottom: space.lg,
						alignSelf: 'center',
						flexDirection: 'row',
						alignItems: 'center',
						gap: space.sm,
						paddingVertical: 12,
						paddingHorizontal: space.lg,
						borderRadius: 999,
						backgroundColor: c.fg,
						transform: [{ scale: pressed ? 0.97 : 1 }],
					})}
				>
					<Text style={{ color: c.bg, fontFamily: font.semibold, fontVariant: ['tabular-nums'] }}>{pillLabel}</Text>
					<Ionicons name="chevron-up" size={16} color={c.bg} />
				</Pressable>
			)}
			<ReadingSheet
				visible={sheetOpen}
				onClose={() => setSheetOpen(false)}
				item={item}
				current={current + 1}
				total={sections.length}
				focus={focus}
				inSession={Boolean(session)}
				next={next}
				links={links}
				linked={linked}
				explanations={explanations}
				onOpenLink={setLink}
			/>
			<ExplainSheet itemId={id} request={explaining} onClose={() => setExplaining(null)} />
			<LinkSheet itemId={id} href={link} saved={link ? linked[link] : undefined} onClose={() => setLink(null)} />
		</View>
	)
}
