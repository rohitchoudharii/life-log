import { useQuery } from '@tanstack/react-query'
import { useFocusEffect, useRouter } from 'expo-router'
import { useCallback } from 'react'
import { api } from '@/api'
import { Button, ErrorText, Group, Loading, Pill, Row, Screen, Text, Tile } from '@/ui'

const greeting = () => {
	const h = new Date().getHours()
	return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}

export default function Today() {
	const router = useRouter()
	const today = useQuery({ queryKey: ['today'], queryFn: api.today })
	const key = useQuery({ queryKey: ['key'], queryFn: api.key })
	const items = useQuery({ queryKey: ['items'], queryFn: api.items })
	const { refetch } = today
	useFocusEffect(useCallback(() => void refetch(), [refetch]))

	if (today.isPending) return <Loading />
	if (today.error) return <Screen><ErrorText error={today.error} /></Screen>
	const t = today.data

	return (
		<Screen
			footer={
				t.due > 0 ? (
					<Button title={`Review ${t.due} idea${t.due === 1 ? '' : 's'}`} onPress={() => router.push('/review')} />
				) : undefined
			}
		>
			<Group>
				<Row>
					<Text variant="muted">{greeting()}</Text>
					{t.streak > 0 && <Pill filled>{t.streak}-day streak</Pill>}
				</Row>
				<Text variant="title">
					{t.due > 0 ? `${t.due} idea${t.due === 1 ? '' : 's'} due today` : t.reviewedToday ? 'All caught up for today' : 'Nothing due yet'}
				</Text>
			</Group>

			<Group gap={10}>
				{key.data && !key.data.key && (
					<Tile onPress={() => router.push('/llm-key')}>
						<Text variant="label">Set up</Text>
						<Text>Connect your Anthropic or OpenAI key</Text>
						<Text variant="muted">Questions are written by your own AI account. Takes about 2 minutes.</Text>
					</Tile>
				)}
				{items.data?.items.length === 0 && (
					<Tile onPress={() => router.push('/add')}>
						<Text variant="label">Start here</Text>
						<Text>Add your first reading</Text>
						<Text variant="muted">Paste an article, notes, or a chapter. Life Log Club splits it into sections and writes questions for each.</Text>
					</Tile>
				)}
			</Group>

			{t.ongoing.length > 0 && (
				<Group gap={10}>
					<Text variant="label">Ongoing readings</Text>
					{t.ongoing.map((item) => (
						<Tile key={item.id} onPress={() => router.push(`/read/${item.id}`)}>
							<Text>{item.title}</Text>
						</Tile>
					))}
				</Group>
			)}
		</Screen>
	)
}
