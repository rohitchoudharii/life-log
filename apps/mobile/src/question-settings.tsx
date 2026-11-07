import type { QuestionIntensity, QuestionStyle } from '@life-log-club/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from './api'
import { space } from './theme'
import { Choice, ChoiceRow, ErrorText, Group, Row, Text, Tile, Toggle } from './ui'

/**
 * The Guess first switch. It is one setting for the learner, shown on the test picker, on the Review
 * start screen, and in Settings, so turning it on in one place turns it on everywhere.
 */
export function GuessFirstSetting() {
	const queryClient = useQueryClient()
	const me = useQuery({ queryKey: ['me'], queryFn: api.me })
	const update = useMutation({
		mutationFn: (guessFirst: boolean) => api.updateMe({ guessFirst }),
		onSuccess: (next) => queryClient.setQueryData(['me'], next),
	})
	if (!me.data) return null
	return (
		<Tile>
			<Row>
				<Group gap={2} style={{ flex: 1 }}>
					<Text>Guess first</Text>
					<Text variant="muted">Type your guess before you see the choices, then tap how sure you are.</Text>
				</Group>
				<Toggle
					accessibilityLabel="Guess first"
					value={update.isPending ? update.variables : me.data.guessFirst}
					onValueChange={(on) => update.mutate(on)}
				/>
			</Row>
			<ErrorText error={update.error} />
		</Tile>
	)
}

export const INTENSITIES: { value: QuestionIntensity; label: string; detail: string }[] = [
	{ value: 'quick', label: 'Quick', detail: 'Key ideas only' },
	{ value: 'standard', label: 'Standard', detail: 'Every main idea' },
	{ value: 'thorough', label: 'Thorough', detail: 'As many as possible' },
]

export const STYLES: { value: QuestionStyle; label: string; detail: string }[] = [
	{
		value: 'mixed',
		label: 'Mixed',
		detail: 'Life Log Club picks the type that fits each idea: code gets predict the output and find the error, math gets worked problems, processes get steps to order.',
	},
	{
		value: 'written',
		label: 'Written',
		detail: 'Explain it, work out a number, predict what code prints, find the error. Numbers and outputs are checked exactly; explanations by your AI. Harder, and they stick better.',
	},
	{ value: 'choice', label: 'Choice', detail: 'Multiple choice and putting steps in order, graded instantly without your AI.' },
]

/** "Standard, Mixed": a quiz's settings in a few words. */
export const settingsLabel = (intensity: QuestionIntensity, style: QuestionStyle) =>
	`${INTENSITIES.find((o) => o.value === intensity)!.label}, ${STYLES.find((o) => o.value === style)!.label}`

/** How many questions to write, and which kinds: the defaults in Settings, and each quiz in Manage test. */
export function QuestionSettings({
	intensity,
	style,
	onChange,
}: {
	intensity: QuestionIntensity
	style: QuestionStyle
	onChange(patch: { intensity?: QuestionIntensity; style?: QuestionStyle }): void
}) {
	return (
		<>
			<Group gap={space.xs}>
				<Text>How hard</Text>
				<ChoiceRow>
					{INTENSITIES.map((o) => (
						<Choice key={o.value} label={o.label} detail={o.detail} selected={intensity === o.value} onPress={() => onChange({ intensity: o.value })} />
					))}
				</ChoiceRow>
			</Group>
			<Group gap={space.xs}>
				<Text>Style</Text>
				<ChoiceRow>
					{STYLES.map((o) => (
						<Choice key={o.value} label={o.label} selected={style === o.value} onPress={() => onChange({ style: o.value })} />
					))}
				</ChoiceRow>
				<Text variant="muted">{STYLES.find((o) => o.value === style)?.detail}</Text>
			</Group>
		</>
	)
}
