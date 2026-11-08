import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { errorMessage, orpc } from '../rpc'
import { ErrorText } from '../ui'

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })

function lastActive(date: Date) {
	const minutes = Math.round((Date.now() - date.getTime()) / 60_000)
	if (minutes < 2) return 'Active now'
	if (minutes < 60) return `Active ${relative.format(-minutes, 'minute')}`
	const hours = Math.round(minutes / 60)
	if (hours < 24) return `Active ${relative.format(-hours, 'hour')}`
	return `Active ${relative.format(-Math.round(hours / 24), 'day')}`
}

export function Devices() {
	const queryClient = useQueryClient()
	const devices = useQuery(orpc.devices.list.queryOptions())
	const signOut = useMutation(
		orpc.devices.signOut.mutationOptions({ onSuccess: () => queryClient.invalidateQueries() }),
	)
	return (
		<section className="grid gap-4">
			<div>
				<h1 className="text-2xl font-semibold">Signed-in devices</h1>
				<p className="text-sm text-ink/60">
					Sign out a device you lost or no longer use. A device you don't use for 30 days signs out by itself.
				</p>
			</div>
			<ErrorText>{signOut.isError && errorMessage(signOut.error)}</ErrorText>
			<ul className="divide-y divide-ink/10 rounded-2xl bg-white ring-1 ring-ink/5">
				{devices.data?.map((d) => (
					<li key={d.id} className="flex flex-wrap items-center gap-3 px-4 py-3" data-testid="device">
						<div className="mr-auto">
							<p className="font-medium">
								{d.label}
								{d.current && <span className="ml-2 rounded bg-cream px-1.5 py-0.5 text-xs">This device</span>}
							</p>
							<p className="text-sm text-ink/60">{lastActive(d.lastSeenAt)}</p>
						</div>
						<button
							type="button"
							className="rounded-lg border border-ink/15 px-3 py-1.5 text-sm hover:bg-red/10 hover:text-red"
							disabled={signOut.isPending}
							onClick={() => signOut.mutate({ id: d.id })}
						>
							Sign out
						</button>
					</li>
				))}
			</ul>
		</section>
	)
}
