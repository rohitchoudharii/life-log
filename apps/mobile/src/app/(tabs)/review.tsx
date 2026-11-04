import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useFocusEffect } from 'expo-router'
import { useCallback, useState } from 'react'
import { api } from '@/api'
import { PracticeSession } from '@/practice'
import { Button, ErrorText, Group, Loading, Screen, Text } from '@/ui'

export default function Review() {
	const queryClient = useQueryClient()
	const [started, setStarted] = useState(false)
	const due = useQuery({ queryKey: ['due'], queryFn: api.due, enabled: !started })
	const { refetch } = due
	useFocusEffect(useCallback(() => void (!started && refetch()), [started, refetch]))

	if (due.isPending) return <Loading />
	const questions = due.data?.questions ?? []

	if (started && questions.length)
		return (
			<PracticeSession
				title="Review"
				questions={questions}
				onDone={() => {
					setStarted(false)
					queryClient.invalidateQueries({ queryKey: ['due'] })
				}}
			/>
		)

	return (
		<Screen footer={questions.length ? <Button title={`Review ${questions.length} idea${questions.length === 1 ? '' : 's'}`} onPress={() => setStarted(true)} /> : undefined}>
			<Group>
				<Text variant="title">Review</Text>
				<Text variant="muted">
					Each idea comes back after 1, 2, and 3 days, then at longer gaps, with a different question each time. Right answers make the next question harder. An idea is learned once you recall it on 3 separate days.
				</Text>
			</Group>
			<ErrorText error={due.error} />
			<Text>
				{questions.length
					? `${questions.length} idea${questions.length === 1 ? ' is' : 's are'} due. Topics are mixed on purpose: switching between subjects makes recall stronger.`
					: 'Nothing is due right now. Read a section and test yourself on it to add its ideas.'}
			</Text>
		</Screen>
	)
}
