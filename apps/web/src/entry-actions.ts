import type { Entry } from '@life-log-club/contract'
import type { EntryData } from '@life-log-club/domain'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { describe } from './entries'
import { client, errorMessage, orpc } from './rpc'
import { useToast } from './toast'

/**
 * Every list and summary reads entries, so any change refreshes them all. A lesson's review card
 * comes and goes with its entry, so the review counts refresh too.
 */
function useRefresh() {
	const queryClient = useQueryClient()
	return () => Promise.all([queryClient.invalidateQueries({ queryKey: orpc.entries.key() }), queryClient.invalidateQueries({ queryKey: orpc.review.key() })])
}

/** Saves an entry and offers Undo. The client picks the id, so a retry can't make a duplicate. */
export function useLogEntry() {
	const refresh = useRefresh()
	const toast = useToast()
	return useMutation({
		mutationFn: (data: EntryData & { text?: string; remember?: boolean }) => client.entries.create({ ...data, id: crypto.randomUUID() }),
		onSuccess: async (entry: Entry) => {
			await refresh()
			toast({
				text: `Saved: ${describe(entry)}`,
				undo: () => void client.entries.remove({ id: entry.id }).then(refresh),
			})
		},
		onError: (error) => toast({ text: errorMessage(error) }),
	})
}

export function useRemoveEntry() {
	const refresh = useRefresh()
	const toast = useToast()
	return useMutation({
		mutationFn: (entry: Entry) => client.entries.remove({ id: entry.id }).then(() => entry),
		onSuccess: async (entry) => {
			await refresh()
			toast({
				text: `Removed: ${describe(entry)}`,
				undo: () => void client.entries.restore({ id: entry.id }).then(refresh),
			})
		},
		onError: (error) => toast({ text: errorMessage(error) }),
	})
}
