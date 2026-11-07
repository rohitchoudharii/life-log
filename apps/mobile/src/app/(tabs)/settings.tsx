import Ionicons from '@expo/vector-icons/Ionicons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'expo-router'
import { useState } from 'react'
import { Pressable, View } from 'react-native'
import { api, type ExplainLevel, type Me } from '@/api'
import { GuessFirstSetting, QuestionSettings } from '@/question-settings'
import { remindersSupported, scheduleDailyReminder } from '@/reminders'
import { useSession } from '@/session'
import { hairline, radius, setAppearance, space, useAppearance, useColors, type Appearance } from '@/theme'
import { Button, Choice, ChoiceRow, ErrorText, Group, Loading, Row, Screen, Text, Tile, Toggle } from '@/ui'

function Stepper({ label, value, onMinus, onPlus }: { label: string; value: string; onMinus(): void; onPlus(): void }) {
	const c = useColors()
	const btn = (icon: 'remove' | 'add', onPress: () => void, a11y: string) => (
		<Pressable
			accessibilityRole="button"
			accessibilityLabel={a11y}
			onPress={onPress}
			style={({ pressed }) => ({
				width: 40,
				height: 40,
				alignItems: 'center',
				justifyContent: 'center',
				borderRadius: radius,
				borderWidth: hairline,
				borderColor: pressed ? c.fg : c.ring,
			})}
		>
			<Ionicons name={icon} size={18} color={c.fg} />
		</Pressable>
	)
	return (
		<Row>
			<Text>{label}</Text>
			<Row style={{ gap: space.sm }}>
				{btn('remove', onMinus, `Decrease ${label}`)}
				<Text style={{ minWidth: 56, textAlign: 'center', fontVariant: ['tabular-nums'] }}>{value}</Text>
				{btn('add', onPlus, `Increase ${label}`)}
			</Row>
		</Row>
	)
}

const APPEARANCES: { value: Appearance; label: string }[] = [
	{ value: 'system', label: 'System' },
	{ value: 'light', label: 'Light' },
	{ value: 'dark', label: 'Dark' },
]


const EXPLAIN_LEVELS: { value: ExplainLevel; label: string }[] = [
	{ value: 'new', label: 'New to this' },
	{ value: 'standard', label: 'Standard' },
	{ value: 'expert', label: 'Expert' },
]
const shiftTime = (time: string, minutes: number) => {
	const [h, m] = time.split(':').map(Number)
	const total = (((h! * 60 + m! + minutes) % 1440) + 1440) % 1440
	return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

export default function Settings() {
	const router = useRouter()
	const { signOut } = useSession()
	const queryClient = useQueryClient()
	const me = useQuery({ queryKey: ['me'], queryFn: api.me })
	const key = useQuery({ queryKey: ['key'], queryFn: api.key })
	const [notice, setNotice] = useState<string | null>(null)
	const appearance = useAppearance()

	const update = useMutation({
		mutationFn: (patch: Partial<Omit<Me, 'email'>>) => api.updateMe(patch),
		onSuccess: async (next) => {
			queryClient.setQueryData(['me'], next)
			queryClient.invalidateQueries({ queryKey: ['today'] })
			const ok = await scheduleDailyReminder(next.reminderTime)
			setNotice(
				next.reminderTime && remindersSupported && !ok
					? 'Notifications are off for Life Log Club, so no reminder will show. That is fine: the streak still tracks you.'
					: null,
			)
		},
	})

	if (me.isPending) return <Loading />
	const m = me.data
	const k = key.data?.key

	return (
		<Screen>
			<Group>
				<Text variant="title">Settings</Text>
				{m && <Text variant="muted">{m.email}</Text>}
			</Group>
			<ErrorText error={me.error ?? update.error} />

			<Group gap={10}>
				<Text variant="label">AI</Text>
				<Tile onPress={() => router.push('/llm-key')}>
					<Text>{k ? `${k.provider === 'anthropic' ? 'Anthropic' : 'OpenAI'} connected` : 'No AI connected'}</Text>
					<Text variant="muted">{k ? `${k.model}, key ending ${k.last4}` : 'Add your own key to generate questions'}</Text>
				</Tile>
			</Group>

			{m && (
				<Group gap={10}>
					<Text variant="label">Questions</Text>
					<Tile style={{ gap: space.md }}>
						<QuestionSettings
							intensity={m.questionIntensity}
							style={m.questionStyle}
							onChange={({ intensity, style }) => update.mutate({ questionIntensity: intensity, questionStyle: style })}
						/>
						<Text variant="muted">Where Manage test starts. Each reading keeps the settings its quiz was made with.</Text>
					</Tile>
					<GuessFirstSetting />
					<Tile>
						<Row>
							<Group gap={2} style={{ flex: 1 }}>
								<Text>Check new questions</Text>
								<Text variant="muted">A second AI pass checks each question and its answer before you see it. Costs one extra AI call per batch of sections.</Text>
							</Group>
							<Toggle accessibilityLabel="Check new questions" value={m.qualityCheck} onValueChange={(on) => update.mutate({ qualityCheck: on })} />
						</Row>
					</Tile>
				</Group>
			)}

			{m && (
				<Group gap={10}>
					<Text variant="label">Explanations</Text>
					<Tile style={{ gap: space.md }}>
						<Group gap={space.xs}>
							<Text>Explain for</Text>
							<ChoiceRow>
								{EXPLAIN_LEVELS.map((o) => (
									<Choice key={o.value} label={o.label} selected={m.explainLevel === o.value} onPress={() => update.mutate({ explainLevel: o.value })} />
								))}
							</ChoiceRow>
						</Group>
						<Text variant="muted">Select text while reading, then tap Explain, Analogy or Example. The level menu on that pill changes this too.</Text>
					</Tile>
				</Group>
			)}

			<Group gap={10}>
				<Text variant="label">Appearance</Text>
				<ChoiceRow>
					{APPEARANCES.map((o) => (
						<Choice key={o.value} label={o.label} selected={appearance === o.value} onPress={() => setAppearance(o.value)} />
					))}
				</ChoiceRow>
			</Group>

			{m && (
				<Group gap={10}>
					<Text variant="label">Discipline</Text>
					<Tile style={{ gap: space.md }}>
						<Row>
							<Group gap={2} style={{ flex: 1 }}>
								<Text>Daily reminder</Text>
								<Text variant="muted">
									{remindersSupported ? 'One nudge a day at the same time' : 'Reminders work in the phone app'}
								</Text>
							</Group>
							<Toggle
								accessibilityLabel="Daily reminder"
								value={Boolean(m.reminderTime)}
								disabled={!remindersSupported}
								onValueChange={(on) => update.mutate({ reminderTime: on ? '20:00' : null })}
							/>
						</Row>
						{m.reminderTime && (
							<Stepper
								label="Time"
								value={m.reminderTime}
								onMinus={() => update.mutate({ reminderTime: shiftTime(m.reminderTime!, -15) })}
								onPlus={() => update.mutate({ reminderTime: shiftTime(m.reminderTime!, 15) })}
							/>
						)}
						{notice && <Text variant="muted">{notice}</Text>}
					</Tile>
					<Tile style={{ gap: space.md }}>
						<Stepper
							label="Daily review limit"
							value={String(m.dailyReviewCap)}
							onMinus={() => update.mutate({ dailyReviewCap: Math.max(10, m.dailyReviewCap - 10) })}
							onPlus={() => update.mutate({ dailyReviewCap: Math.min(500, m.dailyReviewCap + 10) })}
						/>
						<Text variant="muted">Caps how many reviews come back each day, so the pile never becomes a reason to skip.</Text>
					</Tile>
				</Group>
			)}

			<View style={{ flex: 1 }} />
			<Button title="Sign out" kind="outline" onPress={signOut} />
		</Screen>
	)
}
