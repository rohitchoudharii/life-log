import type { Entry } from '@life-log-club/contract'
import { useRemoveEntry } from './entry-actions'
import { describe, note, PILLAR_DOT, when } from './entries'

/** Recent entries, newest first, each with a Remove that can be undone. */
export function EntryList({ entries, empty }: { entries: Entry[] | undefined; empty: string }) {
	const remove = useRemoveEntry()
	if (!entries) return null
	if (!entries.length) return <p className="rounded-2xl border border-dashed border-world-line px-4 py-6 text-sm text-world-muted">{empty}</p>
	return (
		<ul className="divide-y divide-world-line overflow-hidden rounded-2xl border border-world-line bg-world-card">
			{entries.map((e) => (
				<li key={e.id} data-testid="entry" className="group flex items-start gap-3 px-4 py-3">
					<span className={`mt-2 size-2 shrink-0 rounded-full ${PILLAR_DOT[e.pillar]}`} />
					<div className="min-w-0 flex-1">
						<p className="break-words">{describe(e)}</p>
						{note(e) && <p className="mt-0.5 break-words text-sm text-world-muted">{note(e)}</p>}
					</div>
					<span className="shrink-0 pt-0.5 text-xs text-world-muted">{when(e.occurredAt)}</span>
					<button
						type="button"
						aria-label={`Remove ${describe(e)}`}
						onClick={() => remove.mutate(e)}
						className="-my-1 shrink-0 rounded-md px-2 py-1 text-world-muted opacity-60 transition hover:bg-world-line hover:opacity-100 focus-visible:opacity-100 md:opacity-0 md:group-hover:opacity-100"
					>
						×
					</button>
				</li>
			))}
		</ul>
	)
}
