import Ionicons from '@expo/vector-icons/Ionicons'
import { questionCountFor, type QuestionIntensity, type QuestionStyle } from '@life-log-club/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useState } from 'react'
import { Pressable } from 'react-native'
import { api, type Section } from '@/api'
import { QuestionSettings, settingsLabel } from '@/question-settings'
import { SectionPicker } from '@/section-picker'
import { hairline, space, useColors } from '@/theme'
import { Button, ErrorText, Group, Loading, Row, Screen, Sheet, Text, Tile } from '@/ui'

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * Manage test: the only place questions are written. The learner picks sections and settings, sees
 * what it will cost and what it replaces, and generates. Sections that have questions get new
 * ones; the rest keep theirs.
 */
export default function ManageTest() {
	const { id } = useLocalSearchParams<{ id: string }>()
	const router = useRouter()
	const c = useColors()
	const queryClient = useQueryClient()
	const data = useQuery({
		queryKey: ['item', id],
		queryFn: () => api.item(id),
		refetchInterval: (q) => (q.state.data?.item.status === 'processing' ? 3000 : false),
	})
	const me = useQuery({ queryKey: ['me'], queryFn: api.me })
	const key = useQuery({ queryKey: ['key'], queryFn: api.key })
	const [selected, setSelected] = useState<Set<string> | null>(null)
	const [chosen, setChosen] = useState<{ intensity?: QuestionIntensity; style?: QuestionStyle }>({})
	const [settingsOpen, setSettingsOpen] = useState(false)
	const generate = useMutation({
		mutationFn: (input: Parameters<typeof api.generateQuiz>[1]) => api.generateQuiz(id, input),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ['items'] })
			queryClient.invalidateQueries({ queryKey: ['item', id] })
			router.back()
		},
	})

	if (data.isPending || me.isPending) return <Loading />
	if (data.error || me.error)
		return (
			<Screen>
				<ErrorText error={data.error ?? me.error} />
			</Screen>
		)
	const { item, sections, links } = data.data
	const hasText = (s: Section) => s.wordCount > 0
	const total = sections.reduce((n, s) => n + s.questionCount, 0) + links.length
	// A first quiz starts with everything picked; after that, nothing, so a tap does not redo it all.
	const picked = selected ?? new Set(total ? [] : sections.filter(hasText).map((s) => s.id))
	const intensity = chosen.intensity ?? item.questionIntensity ?? me.data.questionIntensity
	const style = chosen.style ?? item.questionStyle ?? me.data.questionStyle

	const toWrite = sections.filter((s) => picked.has(s.id) && hasText(s))
	const estimate = toWrite.reduce((n, s) => n + questionCountFor(s.wordCount, intensity), 0)
	const ids = new Set(toWrite.map((s) => s.id))
	const replaced = toWrite.filter((s) => s.questionCount > 0)
	const replacedLinks = links.filter((l) => l.sectionIds.some((s) => ids.has(s))).length
	const lost = replaced.reduce((n, s) => n + s.questionCount, 0) + replacedLinks
	const writing = item.status === 'processing'
	const noKey = key.data && !key.data.key

	const filter = (label: string, next: () => Section[]) => (
		<Pressable
			accessibilityRole="button"
			onPress={() => setSelected(new Set(next().map((s) => s.id)))}
			hitSlop={6}
			style={({ pressed }) => ({ paddingVertical: 4, paddingHorizontal: 10, borderRadius: 999, borderWidth: hairline, borderColor: pressed ? c.fg : c.ring })}
		>
			<Text style={{ fontSize: 13 }}>{label}</Text>
		</Pressable>
	)

	return (
		<Screen
			footer={
				<Group gap={space.sm}>
					<Pressable
						accessibilityRole="button"
						accessibilityLabel={`Settings: ${settingsLabel(intensity, style)}. Change`}
						onPress={() => setSettingsOpen(true)}
						style={({ pressed }) => ({ paddingVertical: space.md, borderBottomWidth: hairline, borderColor: c.ring, opacity: pressed ? 0.6 : 1 })}
					>
						<Row>
							<Text>Settings</Text>
							<Row style={{ gap: space.xs }}>
								<Text variant="muted">{settingsLabel(intensity, style)}</Text>
								<Ionicons name="chevron-forward" size={16} color={c.sub} />
							</Row>
						</Row>
					</Pressable>
					{lost > 0 && (
						<Text style={{ fontSize: 13, lineHeight: 18 }}>
							Replaces {plural(lost, 'question')}
							{replaced.length ? ` in ${plural(replaced.length, 'section')}` : ''}, with their review history.
						</Text>
					)}
					<Text variant="muted" style={{ fontSize: 13, lineHeight: 18 }}>
						{toWrite.length
							? `${plural(toWrite.length, 'section')} · about ${plural(estimate, 'question')} · uses your AI key`
							: 'Pick the sections to write questions for.'}
					</Text>
					<Button
						title={writing ? 'Writing questions…' : !toWrite.length ? 'Pick sections' : lost ? 'Generate and replace' : 'Generate quiz'}
						onPress={() => generate.mutate({ sectionIds: toWrite.map((s) => s.id), intensity, style })}
						loading={generate.isPending}
						disabled={!toWrite.length || writing || Boolean(noKey)}
					/>
					<ErrorText error={generate.error} />
				</Group>
			}
		>
			<Group>
				<Text variant="muted">{item.title}</Text>
				<Text variant="title">Manage test</Text>
				<Text variant="muted">
					{total
						? `${plural(total - links.length, 'question')}${links.length ? ` + ${links.length} linking` : ''} in ${sections.filter((s) => s.questionCount > 0).length} of ${sections.filter(hasText).length} sections${
								item.questionIntensity && item.questionStyle ? ` · ${settingsLabel(item.questionIntensity, item.questionStyle)}` : ''
							}`
						: 'No questions yet. Nothing is written until you tap Generate.'}
				</Text>
			</Group>
			{writing && <Text variant="muted">Writing questions now. You can leave this screen; they keep coming in.</Text>}
			{item.status === 'failed' && <Text variant="muted">Your AI could not write the last questions: {item.error}. Generate again to retry.</Text>}
			{noKey && (
				<Tile onPress={() => router.push('/llm-key')}>
					<Text>Connect your AI to write questions</Text>
					<Text variant="muted">Questions are written with your own Anthropic or OpenAI key.</Text>
				</Tile>
			)}
			<Group gap={space.sm}>
				<Row style={{ justifyContent: 'flex-start', gap: space.sm, flexWrap: 'wrap' }}>
					{filter('All', () => sections.filter(hasText))}
					{filter('Without questions', () => sections.filter((s) => hasText(s) && s.questionCount === 0))}
					{filter('Clear', () => [])}
				</Row>
				<SectionPicker sections={sections} selected={picked} onChange={setSelected} canPick={hasText} empty="None" />
			</Group>
			<Sheet visible={settingsOpen} onClose={() => setSettingsOpen(false)}>
				<Text variant="heading">Settings</Text>
				<QuestionSettings intensity={intensity} style={style} onChange={(patch) => setChosen({ ...chosen, ...patch })} />
				<Button title="Done" onPress={() => setSettingsOpen(false)} />
			</Sheet>
		</Screen>
	)
}
