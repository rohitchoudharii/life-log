import type { Milestone, Reading } from '@life-log-club/contract'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { client, errorMessage, orpc } from './rpc'
import { useToast } from './toast'

const MAX_LESSONS = 3
const quiet = 'rounded-xl border border-world-line px-4 py-2 font-sans text-sm font-semibold transition hover:bg-world active:scale-[0.97] disabled:opacity-60'
const primary = 'rounded-xl bg-world-accent px-5 py-2 font-sans text-sm font-semibold text-world-on-accent transition hover:opacity-90 disabled:opacity-60'

/** Refreshes everything finishing changes: the reading, the lists on Mind, the entries and the milestone. */
function useRefresh() {
	const queryClient = useQueryClient()
	return () =>
		Promise.all([
			queryClient.invalidateQueries({ queryKey: orpc.readings.key() }),
			queryClient.invalidateQueries({ queryKey: orpc.entries.key() }),
			queryClient.invalidateQueries({ queryKey: orpc.review.key() }),
		])
}

/** Undoes Finished, from the toast or the milestone card. */
function useUnfinish(reading: Reading) {
	const refresh = useRefresh()
	const toast = useToast()
	return useMutation({
		mutationFn: () => client.readings.unfinish({ id: reading.id }),
		onSuccess: refresh,
		onError: (error) => toast({ text: errorMessage(error) }),
	})
}

/** Finished: one click marks the reading finished and logs it, with Undo in a toast. */
export function useFinish(reading: Reading, onDone?: () => void) {
	const refresh = useRefresh()
	const toast = useToast()
	const unfinish = useUnfinish(reading)
	return useMutation({
		mutationFn: () => client.readings.finish({ id: reading.id, entryId: crypto.randomUUID() }),
		onSuccess: async () => {
			await refresh()
			onDone?.()
			toast({ text: `Finished: ${reading.title}`, undo: () => unfinish.mutate() })
		},
		onError: (error) => toast({ text: errorMessage(error) }),
	})
}

function spent(seconds: number) {
	const minutes = Math.round(seconds / 60)
	if (minutes < 60) return `${minutes} min read`
	return `${Math.floor(minutes / 60)} h ${minutes % 60} min read`
}

/** "45 min read · 12 ideas in review · 9 of 10 right at their last review" */
export function milestoneLine(m: Milestone) {
	return [
		spent(m.seconds),
		`${m.ideas} ${m.ideas === 1 ? 'idea' : 'ideas'} in review`,
		m.recall.total ? `${m.recall.right} of ${m.recall.total} right at their last review` : 'no reviews yet',
	].join(' · ')
}

/** The member's key lessons from the reading: the ones saved, then empty lines up to three. */
function Lessons({ reading, milestone }: { reading: Reading; milestone: Milestone }) {
	const refresh = useRefresh()
	const left = MAX_LESSONS - milestone.lessons.length
	const [lines, setLines] = useState(() => Array.from({ length: left }, () => ''))
	const save = useMutation({
		mutationFn: () =>
			client.readings.finish({
				id: reading.id,
				entryId: crypto.randomUUID(),
				lessons: lines.map((text) => text.trim()).filter(Boolean).map((text) => ({ id: crypto.randomUUID(), text })),
			}),
		onSuccess: async () => {
			await refresh()
			setLines([])
		},
	})
	const typed = lines.some((l) => l.trim())
	return (
		<section aria-label="Your key lessons from it" className="grid gap-2">
			<h3 className="font-sans text-xs font-semibold tracking-wide text-world-muted uppercase">Your key lessons from it</h3>
			{milestone.lessons.length > 0 && (
				<ol className="grid list-decimal gap-1 pl-5">
					{milestone.lessons.map((l) => (
						<li key={l.id}>{l.text}</li>
					))}
				</ol>
			)}
			{lines.length > 0 && (
				<form
					className="grid gap-2"
					onSubmit={(e) => {
						e.preventDefault()
						if (typed) save.mutate()
					}}
				>
					{lines.map((line, i) => (
						<input
							key={i}
							aria-label={`Key lesson ${milestone.lessons.length + i + 1}`}
							value={line}
							maxLength={1000}
							onChange={(e) => setLines((all) => all.map((l, k) => (k === i ? e.target.value : l)))}
							className="rounded-xl border border-world-line bg-world px-3 py-2 outline-none focus:border-world-accent"
						/>
					))}
					<p className="font-sans text-xs text-world-muted">Each lesson comes back in Review, so you keep it.</p>
					<div>
						<button type="submit" className={primary} disabled={!typed || save.isPending}>
							Save lessons
						</button>
					</div>
					{save.error && (
						<p role="alert" className="font-sans text-sm text-red">
							{errorMessage(save.error)}
						</p>
					)}
				</form>
			)}
		</section>
	)
}

/**
 * The end of a reading's last section. Before it is finished: Finished, one click. After: the
 * milestone (time read, ideas kept, recall at review), its key lessons, and Undo.
 */
export function FinishCard({ reading }: { reading: Reading }) {
	const finish = useFinish(reading)
	const unfinish = useUnfinish(reading)
	const milestone = useQuery({ ...orpc.readings.milestone.queryOptions({ input: { id: reading.id } }), enabled: Boolean(reading.finishedAt) })
	if (!reading.finishedAt)
		return (
			<div className="grid gap-3 rounded-2xl border border-world-line bg-world-card p-5 shadow-sm">
				<p className="font-sans text-xs font-semibold tracking-wide text-world-muted uppercase">End of the reading</p>
				<p className="text-lg">Done with it? Mark it finished to keep it as a milestone.</p>
				<div>
					<button type="button" className={quiet} disabled={finish.isPending} onClick={() => finish.mutate()}>
						Finished
					</button>
				</div>
			</div>
		)
	const day = reading.finishedAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
	return (
		<section aria-label="Finished" className="grid gap-4 rounded-2xl border border-world-accent bg-world-card p-5 shadow-sm">
			<div className="grid gap-1">
				<p className="font-sans text-xs font-semibold tracking-wide text-world-muted uppercase">Finished · {day}</p>
				<h2 className="text-2xl">{reading.title}</h2>
				{milestone.data && (
					<p className="font-sans text-sm text-world-muted" data-testid="milestone">
						{milestoneLine(milestone.data)}
					</p>
				)}
			</div>
			{milestone.data && <Lessons key={milestone.data.lessons.length} reading={reading} milestone={milestone.data} />}
			<div>
				<button type="button" className="font-sans text-sm text-world-muted underline underline-offset-2" disabled={unfinish.isPending} onClick={() => unfinish.mutate()}>
					Undo finished
				</button>
			</div>
		</section>
	)
}
