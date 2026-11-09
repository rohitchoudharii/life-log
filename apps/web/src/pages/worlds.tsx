import type { EntryType } from '@life-log-club/domain'
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useLogEntry } from '../entry-actions'
import { EntryList } from '../entry-list'
import { isToday, MOODS, when } from '../entries'
import { AddReading, ReadingNow, useFileDrop } from '../readings'
import { orpc } from '../rpc'
import { useOpenLog } from '../shell'

function Hero({ title, sub, children }: { title: string; sub: string; children?: ReactNode }) {
	return (
		<div className="flex flex-wrap items-end gap-4">
			<div className="mr-auto">
				<h1 className="text-3xl font-semibold tracking-tight md:text-4xl">{title}</h1>
				<p className="mt-1 text-world-muted">{sub}</p>
			</div>
			{children}
		</div>
	)
}

function LogButton({ type, children, quiet }: { type: EntryType; children: ReactNode; quiet?: boolean }) {
	const openLog = useOpenLog()
	return (
		<button
			type="button"
			onClick={() => openLog(type)}
			className={
				quiet
					? 'rounded-xl border border-world-line px-4 py-2.5 text-sm font-medium transition hover:bg-world-card active:scale-[0.97]'
					: 'rounded-xl bg-world-accent px-4 py-2.5 text-sm font-semibold text-world-on-accent shadow-sm transition hover:opacity-90 active:scale-[0.97]'
			}
		>
			{children}
		</button>
	)
}

function Stat({ label, value, sub, testId }: { label: string; value: ReactNode; sub?: string; testId?: string }) {
	return (
		<div className="rounded-2xl border border-world-line bg-world-card p-4">
			<p className="text-xs font-medium tracking-wide text-world-muted uppercase">{label}</p>
			<p className="mt-1 text-3xl font-bold tracking-tight" data-testid={testId}>
				{value}
			</p>
			{sub && <p className="text-sm text-world-muted">{sub}</p>}
		</div>
	)
}

export function Mind() {
	const due = useQuery(orpc.review.due.queryOptions({ input: { limit: 3 } }))
	const lessons = useQuery(orpc.entries.list.queryOptions({ input: { pillar: 'mind', limit: 50 } }))
	const drop = useFileDrop()
	return (
		<div className="relative grid gap-8" {...drop.handlers}>
			{drop.dragging && (
				<div className="pointer-events-none absolute -inset-3 z-10 grid place-items-center rounded-3xl border-2 border-dashed border-world-accent bg-world/85 text-xl">
					Drop the EPUB or PDF to add it
				</div>
			)}
			<Hero title="The reading room" sub="Read, then recall. Ideas and lessons come back until they stick.">
				<LogButton type="lesson">Log a lesson</LogButton>
			</Hero>
			<AddReading />
			<div className="grid gap-4 md:grid-cols-[16rem_1fr]">
				<Stat label="Due for review" value={due.data?.total ?? 0} sub="cards" testId="mind-due" />
				<div className="rounded-2xl border border-world-line bg-world-card p-5">
					<p className="text-xs font-medium tracking-wide text-world-muted uppercase">Coming back next</p>
					{due.data?.cards.length ? (
						<ul className="mt-2 grid gap-2">
							{due.data.cards.map((c) => (
								<li key={c.id} className="text-lg">
									{c.prompt}
								</li>
							))}
						</ul>
					) : (
						<p className="mt-2 text-lg">Nothing due. Recall checks on your readings arrive here next.</p>
					)}
				</div>
			</div>
			<section className="grid gap-3">
				<h2 className="text-xl">Reading now</h2>
				<ReadingNow />
			</section>
			<section className="grid gap-3">
				<h2 className="text-xl">Lessons</h2>
				<EntryList entries={lessons.data} empty="No lessons yet. Log what life teaches you." />
			</section>
		</div>
	)
}

export function Body() {
	const body = useQuery(orpc.entries.list.queryOptions({ input: { pillar: 'body', limit: 100 } }))
	const entries = body.data ?? []
	const lastSet = entries.find((e) => e.type === 'gym.set')
	const protein = entries.reduce((sum, e) => sum + (e.type === 'meal' && isToday(e.occurredAt) ? e.details.proteinG : 0), 0)
	const weekAgo = Date.now() - 7 * 86_400_000
	const setsThisWeek = entries.filter((e) => e.type === 'gym.set' && e.occurredAt.getTime() > weekAgo).length
	const sleep = entries.find((e) => e.type === 'sleep')
	return (
		<div className="grid gap-8">
			<Hero title="The training log" sub="Records come from every set you log.">
				<div className="flex flex-wrap gap-2">
					<LogButton type="gym.set">Log a set</LogButton>
					<LogButton type="meal" quiet>
						Log a meal
					</LogButton>
					<LogButton type="sleep" quiet>
						Log sleep
					</LogButton>
				</div>
			</Hero>
			<div className="grid grid-cols-2 gap-3 md:grid-cols-4">
				<Stat
					label="Last set"
					value={lastSet?.type === 'gym.set' ? `${lastSet.details.weightKg} kg` : '—'}
					sub={lastSet?.type === 'gym.set' ? `${lastSet.details.exercise} × ${lastSet.details.reps}` : 'none yet'}
				/>
				<Stat label="Sets" value={setsThisWeek} sub="in the last 7 days" testId="sets-week" />
				<Stat label="Protein" value={`${protein} g`} sub="today" testId="protein-today" />
				<Stat label="Sleep" value={sleep?.type === 'sleep' ? `${sleep.details.hours} h` : '—'} sub={sleep ? when(sleep.occurredAt) : 'none yet'} />
			</div>
			<section className="grid gap-3">
				<h2 className="text-xs font-semibold tracking-wide text-world-muted uppercase">Log</h2>
				<EntryList entries={body.data} empty="No training logged yet. Log your first set." />
			</section>
		</div>
	)
}

export function Heart() {
	const heart = useQuery(orpc.entries.list.queryOptions({ input: { pillar: 'heart', limit: 100 } }))
	const log = useLogEntry()
	const entries = heart.data ?? []
	const lastMet = new Map<string, Date>()
	for (const e of entries) if (e.type === 'meeting' && !lastMet.has(e.details.person)) lastMet.set(e.details.person, e.occurredAt)
	const mood = entries.find((e) => e.type === 'mood' && isToday(e.occurredAt))
	return (
		<div className="grid gap-8">
			<Hero title="The journal" sub="The people in your life, and how you feel.">
				<div className="flex flex-wrap gap-2">
					<LogButton type="meeting">Log a meeting</LogButton>
					<LogButton type="moment" quiet>
						Log a moment
					</LogButton>
				</div>
			</Hero>
			<div className="grid gap-4 md:grid-cols-2">
				<section className="rounded-3xl border border-world-line bg-world-card p-5">
					<h2 className="font-semibold">How do you feel?</h2>
					<p className="text-sm text-world-muted">{mood?.type === 'mood' ? `Today so far: ${MOODS[mood.details.score - 1]}` : 'One tap. You can change it later.'}</p>
					<div role="group" aria-label="Mood" className="mt-3 grid grid-cols-5 gap-2">
						{MOODS.map((label, i) => (
							<button
								key={label}
								type="button"
								disabled={log.isPending}
								onClick={() => log.mutate({ type: 'mood', details: { score: i + 1 } })}
								className="grid justify-items-center gap-1 rounded-2xl border border-world-line py-3 text-xs transition hover:border-heart hover:bg-heart/15 active:scale-95"
							>
								<span aria-hidden className="text-2xl">{['😞', '😕', '😐', '🙂', '😄'][i]}</span>
								{label}
							</button>
						))}
					</div>
				</section>
				<section className="rounded-3xl border border-world-line bg-world-card p-5">
					<h2 className="font-semibold">People</h2>
					{lastMet.size ? (
						<ul className="mt-3 flex flex-wrap gap-2">
							{[...lastMet].map(([person, at]) => (
								<li key={person} className="flex items-center gap-2 rounded-full bg-heart/15 py-1 pr-3 pl-1 text-sm">
									<span className="grid size-7 place-items-center rounded-full bg-heart font-semibold text-[#3b2d20]">{person.slice(0, 1).toUpperCase()}</span>
									{person}
									<span className="text-world-muted">· {when(at)}</span>
								</li>
							))}
						</ul>
					) : (
						<p className="mt-2 text-sm text-world-muted">People appear here when you log a meeting.</p>
					)}
				</section>
			</div>
			<section className="grid gap-3">
				<h2 className="font-semibold">Journal</h2>
				<EntryList entries={heart.data} empty="Nothing in the journal yet." />
			</section>
		</div>
	)
}
