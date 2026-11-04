import { useQuery } from '@tanstack/react-query'
import { useFocusEffect, useRouter } from 'expo-router'
import { useCallback } from 'react'
import { api, type ItemSummary } from '@/api'
import { Button, ErrorText, Group, Loading, Row, Screen, Text, Tile } from '@/ui'

const statusLabel: Record<ItemSummary['status'], string> = {
	processing: 'Writing questions…',
	ready: '',
	needs_key: 'Waiting for your AI key',
	failed: 'Question writing failed',
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
	return (
		<Screen footer={<Button title="Add to library" onPress={() => router.push('/add')} />}>
			<Group>
				<Text variant="title">Library</Text>
				<Text variant="muted">Everything you are learning from</Text>
			</Group>
			<ErrorText error={items.error} />
			<Group gap={10}>
				{items.data?.items.length === 0 && <Text variant="muted">Nothing here yet. Paste something you want to learn.</Text>}
				{items.data?.items.map((item) => (
					<Tile key={item.id} onPress={() => router.push(`/read/${item.id}`)}>
						<Text>{item.title}</Text>
						<Row>
							<Text variant="muted">
								{item.sectionCount} section{item.sectionCount === 1 ? '' : 's'}, {item.questionCount} question{item.questionCount === 1 ? '' : 's'}
								{item.ideaCount ? `, ${item.ideasLearned} of ${item.ideaCount} ideas learned` : ''}
							</Text>
							{statusLabel[item.status] ? <Text variant="muted">{statusLabel[item.status]}</Text> : null}
						</Row>
					</Tile>
				))}
			</Group>
		</Screen>
	)
}
