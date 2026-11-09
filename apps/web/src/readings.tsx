import type { Reading } from '@life-log-club/contract'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { client, errorMessage, orpc } from './rpc'
import { useToast } from './toast'

const listKey = orpc.readings.list.queryKey()

/** The member's readings, asked for again every 1.5 seconds while one is importing. */
export const useReadings = () =>
	useQuery({
		...orpc.readings.list.queryOptions(),
		refetchInterval: (query) => (query.state.data?.some((r) => r.status === 'importing') ? 1500 : false),
	})

/**
 * Adds a link. It shows in Reading now at once as importing, with the id the client picked, so
 * a retry can't make a second one. A link the member already has opens that reading instead.
 */
function useAddReading() {
	const queryClient = useQueryClient()
	const navigate = useNavigate()
	const toast = useToast()
	const mutation = useMutation({
		mutationFn: (link: { id: string; url: string }) => client.readings.add(link),
		onMutate: async ({ id, url }) => {
			await queryClient.cancelQueries({ queryKey: listKey })
			const placeholder: Reading = {
				id,
				title: url,
				author: null,
				sourceUrl: null,
				requestedUrl: url,
				status: 'importing',
				error: null,
				wordCount: 0,
				sectionCount: 0,
				createdAt: new Date(),
			}
			const before = queryClient.getQueryData<Reading[]>(listKey)
			queryClient.setQueryData<Reading[]>(listKey, (list) => [placeholder, ...(list ?? []).filter((r) => r.requestedUrl !== url)])
			return { before }
		},
		onError: (error, _link, context) => {
			queryClient.setQueryData(listKey, context?.before)
			toast({ text: errorMessage(error) })
		},
		onSuccess: (reading, link) => {
			if (reading.id !== link.id && reading.status === 'ready') {
				toast({ text: 'You already have this reading.' })
				void navigate({ to: '/mind/read/$readingId', params: { readingId: reading.id } })
			}
		},
		onSettled: () => queryClient.invalidateQueries({ queryKey: listKey }),
	})
	return (url: string) => mutation.mutate({ id: crypto.randomUUID(), url })
}

/** One box to paste a link into, and Add. */
export function AddReading() {
	const [url, setUrl] = useState('')
	const add = useAddReading()
	return (
		<form
			className="flex gap-2 rounded-2xl border border-world-line bg-world-card p-2"
			onSubmit={(e) => {
				e.preventDefault()
				if (!url.trim()) return
				add(url.trim())
				setUrl('')
			}}
		>
			<label className="sr-only" htmlFor="add-reading">
				Add a reading
			</label>
			<input
				id="add-reading"
				type="text"
				inputMode="url"
				autoComplete="off"
				placeholder="Paste a link to an article"
				value={url}
				onChange={(e) => setUrl(e.target.value)}
				className="min-w-0 flex-1 rounded-xl bg-transparent px-3 py-2 font-sans text-base outline-none placeholder:text-world-muted"
			/>
			<button
				type="submit"
				className="rounded-xl bg-world-accent px-5 py-2 font-sans text-sm font-semibold text-world-on-accent transition hover:opacity-90 active:scale-[0.97]"
			>
				Add
			</button>
		</form>
	)
}

const minutes = (words: number) => `${Math.max(1, Math.round(words / 230))} min`
// The importing placeholder holds the text as pasted, which may not parse as an address.
const host = (url: string | null) => (url && URL.parse(url)?.hostname.replace(/^www\./, '')) || ''

function useRemoveReading() {
	const queryClient = useQueryClient()
	const toast = useToast()
	const refresh = () => queryClient.invalidateQueries({ queryKey: listKey })
	return useMutation({
		mutationFn: (reading: Reading) => client.readings.remove({ id: reading.id }).then(() => reading),
		onSuccess: async (reading) => {
			await refresh()
			toast({ text: `Removed: ${reading.title}`, undo: () => void client.readings.restore({ id: reading.id }).then(refresh) })
		},
		onError: (error) => toast({ text: errorMessage(error) }),
	})
}

function ReadingItem({ reading }: { reading: Reading }) {
	const add = useAddReading()
	const remove = useRemoveReading()
	const quiet = 'rounded-lg border border-world-line px-3 py-1.5 font-sans text-sm transition hover:bg-world active:scale-[0.97]'
	if (reading.status === 'ready')
		return (
			<li data-testid="reading">
				<Link
					to="/mind/read/$readingId"
					params={{ readingId: reading.id }}
					className="block rounded-2xl border border-world-line bg-world-card p-4 transition hover:border-world-accent"
				>
					<p className="text-lg leading-snug">{reading.title}</p>
					<p className="mt-1 font-sans text-sm text-world-muted">
						{[reading.author, host(reading.sourceUrl), `${reading.sectionCount} ${reading.sectionCount === 1 ? 'section' : 'sections'}`, minutes(reading.wordCount)]
							.filter(Boolean)
							.join(' · ')}
					</p>
				</Link>
			</li>
		)
	return (
		<li data-testid="reading" className="rounded-2xl border border-dashed border-world-line p-4">
			<p className="truncate text-lg leading-snug">{reading.status === 'importing' ? host(reading.requestedUrl) || reading.title : reading.requestedUrl}</p>
			{reading.status === 'importing' ? (
				<p className="mt-1 animate-pulse font-sans text-sm text-world-muted">Importing…</p>
			) : (
				<>
					<p role="alert" className="mt-1 font-sans text-sm text-red">
						{reading.error}
					</p>
					<div className="mt-3 flex gap-2">
						<button type="button" className={quiet} onClick={() => reading.requestedUrl && add(reading.requestedUrl)}>
							Try again
						</button>
						<button type="button" className={quiet} onClick={() => remove.mutate(reading)}>
							Remove
						</button>
					</div>
				</>
			)}
		</li>
	)
}

/** What the member is reading, newest first, with imports still running and the ones that failed. */
export function ReadingNow() {
	const readings = useReadings()
	if (!readings.data) return null
	if (!readings.data.length) return <p className="text-world-muted">Nothing to read yet. Paste a link above to add your first reading.</p>
	return (
		<ul className="grid items-start gap-3 md:grid-cols-2">
			{readings.data.map((r) => (
				<ReadingItem key={r.id} reading={r} />
			))}
		</ul>
	)
}
