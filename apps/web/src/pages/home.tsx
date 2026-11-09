import { RECALL_MIN_REVIEWS } from '@life-log-club/domain'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { EntryList } from '../entry-list'
import { isToday, MOODS, when } from '../entries'
import { orpc } from '../rpc'

/** The swallow's hub: one card per world, each a small preview that opens into it. */
export function Home() {
	const me = useQuery(orpc.auth.me.queryOptions())
	const due = useQuery(orpc.review.due.queryOptions({ input: { limit: 1 } }))
	const mind = useQuery(orpc.mind.summary.queryOptions())
	const recall = mind.data?.recall30d
	const body = useQuery(orpc.entries.list.queryOptions({ input: { pillar: 'body', limit: 100 } }))
	const heart = useQuery(orpc.entries.list.queryOptions({ input: { pillar: 'heart', limit: 100 } }))
	const lately = useQuery(orpc.entries.list.queryOptions({ input: { limit: 8 } }))

	const lastSet = body.data?.find((e) => e.type === 'gym.set')
	const protein = (body.data ?? []).reduce((sum, e) => sum + (e.type === 'meal' && isToday(e.occurredAt) ? e.details.proteinG : 0), 0)
	const lastMeeting = heart.data?.find((e) => e.type === 'meeting')
	const mood = heart.data?.find((e) => e.type === 'mood' && isToday(e.occurredAt))
	const card = 'group flex min-h-56 flex-col gap-4 rounded-3xl p-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md'

	return (
		<div className="grid gap-8">
			<div className="flex items-center gap-4">
				<img src="/logo.png" alt="" className="size-16 rounded-2xl shadow-sm" />
				<div>
					<h1 className="font-serif text-3xl">Welcome, {me.data?.user?.name}</h1>
					<p className="text-world-muted">Four worlds, one log. Step into a pillar.</p>
				</div>
			</div>

			<div className="grid gap-4 md:grid-cols-3">
				{/* The whole card opens Mind; the due count on it opens Review, one click either way. */}
				<div className={`${card} relative bg-mind text-white`}>
					<Link to="/mind" aria-label="Mind: the reading room" className="after:absolute after:inset-0 after:rounded-3xl">
						<Head name="Mind" sub="The reading room" />
					</Link>
					<Link
						to="/mind/review"
						aria-label="Review due ideas"
						className="relative mt-auto rounded-2xl bg-[#f6efe1] p-4 font-serif text-[#272a38] transition hover:ring-2 hover:ring-white/70"
					>
						<p className="text-4xl" data-testid="due-count">
							{due.data?.total ?? 0}
						</p>
						<p className="text-sm text-[#716a5f]">{due.data?.total === 1 ? 'card' : 'cards'} due for review</p>
					</Link>
					{/* One honest number, once it rests on enough reviews to mean something. */}
					{recall && recall.total >= RECALL_MIN_REVIEWS && (
						<p className="relative text-sm text-white/80" data-testid="recall-30d">
							Recalled {Math.round((recall.right / recall.total) * 100)}% at review, last 30 days
						</p>
					)}
				</div>

				<Link to="/body" className={`${card} bg-[#161619] text-[#f3f0ea]`} aria-label="Body: the training log">
					<Head name="Body" sub="The training log" />
					<div className="mt-auto">
						{lastSet?.type === 'gym.set' ? (
							<>
								<p className="text-5xl font-bold tracking-tight text-body" data-testid="last-set">
									{lastSet.details.weightKg}
									<span className="ml-1 text-xl text-[#f3f0ea]">kg × {lastSet.details.reps}</span>
								</p>
								<p className="text-sm text-[#9e9a92]">
									{lastSet.details.exercise} · {when(lastSet.occurredAt)}
								</p>
							</>
						) : (
							<p className="text-sm text-[#9e9a92]">No sets yet. Press + Log after your first one.</p>
						)}
						<p className="mt-3 border-t border-[#303037] pt-3 text-sm text-[#9e9a92]">
							Protein today: <span className="font-semibold text-[#f3f0ea]">{protein} g</span>
						</p>
					</div>
				</Link>

				<Link to="/heart" className={`${card} bg-heart font-rounded text-[#3b2d20]`} aria-label="Heart: the journal">
					<Head name="Heart" sub="The journal" />
					<div className="mt-auto rounded-2xl bg-[#fffcf6] p-4 shadow-sm">
						{lastMeeting?.type === 'meeting' ? (
							<>
								<p className="text-xs text-[#87725c] uppercase">Last met · {when(lastMeeting.occurredAt)}</p>
								<p className="font-semibold" data-testid="last-person">
									{lastMeeting.details.person}
								</p>
								{lastMeeting.text && <p className="line-clamp-2 text-sm text-[#87725c] italic">“{lastMeeting.text}”</p>}
							</>
						) : (
							<p className="text-sm text-[#87725c]">Nobody logged yet.</p>
						)}
					</div>
					<p className="text-sm">{mood?.type === 'mood' ? `Mood today: ${MOODS[mood.details.score - 1]}` : 'No mood check-in yet today'}</p>
				</Link>
			</div>

			<div className="flex items-center gap-3 rounded-2xl border border-dashed border-path/40 px-5 py-4 text-sm">
				<span className="size-2.5 rounded-full bg-path" />
				<span className="font-semibold text-path">Path</span>
				<span className="text-world-muted">Coming later: projects, goals and trips.</span>
			</div>

			<section className="grid gap-3">
				<h2 className="text-xs font-semibold tracking-wide text-world-muted uppercase">Lately, across your worlds</h2>
				<EntryList entries={lately.data} empty="Nothing logged yet. Press + Log, or L on a keyboard." />
			</section>
		</div>
	)
}

function Head({ name, sub }: { name: string; sub: string }) {
	return (
		<div className="flex items-baseline justify-between gap-2">
			<span className="text-lg font-semibold">{name}</span>
			<span className="text-sm opacity-75 transition group-hover:translate-x-0.5">{sub} →</span>
		</div>
	)
}
