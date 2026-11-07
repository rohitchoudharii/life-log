import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState, type ReactNode } from 'react'
import { ActivityIndicator, Animated, Easing, Platform } from 'react-native'
import { api, type ExplainKind } from './api'
import { ExplanationView, Passage } from './notes'
import { space, useColors } from './theme'
import { Button, ErrorText, Group, Row, Sheet, Text } from './ui'

/** Its content fades and rises into place when it first renders. */
function FadeIn({ children }: { children: ReactNode }) {
	const [shown] = useState(() => new Animated.Value(0))
	useEffect(() => {
		Animated.timing(shown, { toValue: 1, duration: 280, easing: Easing.out(Easing.cubic), useNativeDriver: Platform.OS !== 'web' }).start()
	}, [shown])
	return (
		<Animated.View style={{ opacity: shown, transform: [{ translateY: shown.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }] }}>{children}</Animated.View>
	)
}

export type ExplainRequest = { sectionId: string; passage: string; kind: ExplainKind }

const TITLE: Record<ExplainKind, string> = { explain: 'Explanation', analogy: 'Analogy', example: 'Example' }
const WRITING: Record<ExplainKind, string> = { explain: 'Explaining…', analogy: 'Finding an analogy…', example: 'Working an example…' }

/**
 * A passage explained over the reader, so reading picks up where it was. It starts as soon as it
 * opens, at the user's level, and the explanation is kept with the reading.
 */
export function ExplainSheet({ itemId, request, onClose }: { itemId: string; request: ExplainRequest | null; onClose(): void }) {
	const c = useColors()
	const queryClient = useQueryClient()
	const explain = useMutation({
		mutationFn: (r: ExplainRequest) => api.explain(itemId, r),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notes', itemId] }),
	})
	const { mutate, reset } = explain
	useEffect(() => {
		if (request) mutate(request)
		else reset()
	}, [request, mutate, reset])
	const note = explain.data?.note

	return (
		<Sheet visible={request !== null} onClose={onClose} height="75%">
			{request && (
				<>
					<Text variant="label">{TITLE[request.kind]}</Text>
					<Passage text={request.passage} />
					{explain.isPending && (
						<Row style={{ justifyContent: 'flex-start', gap: space.sm }}>
							<ActivityIndicator color={c.sub} />
							<Text variant="muted">{WRITING[request.kind]}</Text>
						</Row>
					)}
					{explain.isError && (
						<Group gap={space.sm}>
							<ErrorText error={explain.error} />
							<Button title="Try again" kind="outline" onPress={() => mutate(request)} />
						</Group>
					)}
					{note?.kind === 'explanation' && (
						<FadeIn>
							<ExplanationView note={note} />
						</FadeIn>
					)}
				</>
			)}
		</Sheet>
	)
}
