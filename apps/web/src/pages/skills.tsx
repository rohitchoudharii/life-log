import type { Skill } from '@life-log-club/contract'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { quiet } from '../books'
import { client, errorMessage, orpc } from '../rpc'
import { useOpenLog } from '../shell'
import { useToast } from '../toast'
import { ErrorText } from '../ui'

const field =
	'w-full rounded-lg border border-world-line bg-world px-3 py-2 font-sans text-base outline-none focus:border-world-accent focus:ring-2 focus:ring-world-accent/20'
const button = 'rounded-xl bg-world-accent px-4 py-2 font-sans text-sm font-semibold text-world-on-accent transition hover:opacity-90 disabled:opacity-60'
const small = 'rounded-lg px-2 py-1 font-sans text-sm text-world-muted transition hover:bg-world hover:text-world-ink'

const sessions = (n: number) => `${n} ${n === 1 ? 'session' : 'sessions'}`
const day = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })

/** This week against the target ("45 of 120 min this week · 2 sessions"), or the sessions alone when there is no target. */
export function weekLine(skill: Pick<Skill, 'week' | 'weeklyMinutes'>) {
	if (skill.weeklyMinutes === null) return `${sessions(skill.week.sessions)} this week`
	return `${skill.week.minutes} of ${skill.weeklyMinutes} min this week · ${sessions(skill.week.sessions)}`
}

/** Minutes against the target, full at the target; nothing to draw without one. */
function WeekBar({ minutes, target }: { minutes: number; target: number | null }) {
	if (target === null) return null
	return (
		<div className="h-2 w-full overflow-hidden rounded-full bg-world-line" aria-hidden>
			<div className="h-full rounded-full bg-world-accent" style={{ width: `${Math.min(1, minutes / target) * 100}%` }} />
		</div>
	)
}

const useRefresh = () => {
	const queryClient = useQueryClient()
	return () => Promise.all([queryClient.invalidateQueries({ queryKey: orpc.skills.key() }), queryClient.invalidateQueries({ queryKey: orpc.progress.key() })])
}

type SkillFields = { name: string; goal: string; weeklyMinutes: string }

/** The name, an optional goal and an optional weekly target: adding a skill, or changing one. */
function SkillForm({ initial, label, onSave, onCancel }: { initial: SkillFields; label: string; onSave: (fields: SkillFields) => Promise<unknown>; onCancel?: () => void }) {
	const [fields, setFields] = useState(initial)
	const save = useMutation({ mutationFn: () => onSave(fields) })
	const set = (key: keyof SkillFields) => (e: { target: { value: string } }) => setFields((f) => ({ ...f, [key]: e.target.value }))
	return (
		<form
			aria-label={label}
			className="grid gap-3 rounded-2xl border border-world-line bg-world-card p-4"
			onSubmit={(e) => {
				e.preventDefault()
				save.mutate()
			}}
		>
			<div className="grid gap-3 md:grid-cols-[1fr_10rem]">
				<label className="grid gap-1.5 font-sans text-sm">
					<span className="font-medium text-world-muted">Skill</span>
					<input className={field} required maxLength={80} autoFocus value={fields.name} onChange={set('name')} placeholder="Piano" />
				</label>
				<label className="grid gap-1.5 font-sans text-sm">
					<span className="font-medium text-world-muted">Minutes a week (optional)</span>
					<input className={field} type="number" inputMode="numeric" min={1} max={3000} value={fields.weeklyMinutes} onChange={set('weeklyMinutes')} placeholder="120" />
				</label>
			</div>
			<label className="grid gap-1.5 font-sans text-sm">
				<span className="font-medium text-world-muted">Goal (optional)</span>
				<input className={field} maxLength={200} value={fields.goal} onChange={set('goal')} placeholder="Play the Bach prelude at 80 bpm" />
			</label>
			<ErrorText>{save.error && errorMessage(save.error)}</ErrorText>
			<div className="flex gap-2">
				<button type="submit" className={button} disabled={save.isPending}>
					Save
				</button>
				{onCancel && (
					<button type="button" className={small} onClick={onCancel}>
						Cancel
					</button>
				)}
			</div>
		</form>
	)
}

/** One click to log practice on a skill, its form already holding the skill, last time's minutes and the next focus. */
export function LogPractice({ skillId, className = button }: { skillId: string; className?: string }) {
	const openLog = useOpenLog()
	return (
		<button type="button" className={className} onClick={() => openLog('practice', skillId)}>
			Log practice
		</button>
	)
}

function SkillCard({ skill }: { skill: Skill }) {
	return (
		<li data-testid="skill" className="grid gap-2 rounded-2xl border border-world-line bg-world-card p-4">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="min-w-0">
					<Link to="/mind/skills/$skillId" params={{ skillId: skill.id }} className="text-xl hover:underline">
						{skill.name}
					</Link>
					{skill.goal && <p className="text-world-muted">{skill.goal}</p>}
				</div>
				<LogPractice skillId={skill.id} />
			</div>
			<p className="font-sans text-sm" data-testid="skill-week">
				{weekLine(skill)}
			</p>
			<WeekBar minutes={skill.week.minutes} target={skill.weeklyMinutes} />
			{skill.last?.nextTime && (
				<p className="font-sans text-sm text-world-muted" data-testid="skill-next">
					Next focus: {skill.last.nextTime}
				</p>
			)}
		</li>
	)
}

/** Every skill the member practises: this week against its target, the next focus, and Log practice. */
export function Skills() {
	const list = useQuery(orpc.skills.list.queryOptions())
	const refresh = useRefresh()
	const [adding, setAdding] = useState(false)
	const skills = list.data ?? []
	const empty = list.isSuccess && !skills.length
	return (
		<section className="mx-auto grid w-full max-w-3xl gap-6">
			<header className="grid gap-1">
				<Link to="/mind" className="font-sans text-sm text-world-muted">
					← The reading room
				</Link>
				<div className="flex flex-wrap items-center justify-between gap-3">
					<h1 className="text-3xl font-semibold tracking-tight">Skills</h1>
					{!adding && !empty && (
						<button type="button" className={quiet} onClick={() => setAdding(true)}>
							Add skill
						</button>
					)}
				</div>
				<p className="text-world-muted">Practise with a focus, note what told you how it went, and pick the fix for next time.</p>
			</header>
			{list.isError && <p role="alert">{errorMessage(list.error)}</p>}
			{(adding || empty) && (
				<SkillForm
					label="Add skill"
					initial={{ name: '', goal: '', weeklyMinutes: '' }}
					onCancel={empty ? undefined : () => setAdding(false)}
					onSave={async (f) => {
						await client.skills.create({ id: crypto.randomUUID(), name: f.name, goal: f.goal || undefined, weeklyMinutes: f.weeklyMinutes ? Number(f.weeklyMinutes) : undefined })
						await refresh()
						setAdding(false)
					}}
				/>
			)}
			{skills.length > 0 && (
				<ul className="grid gap-3">
					{skills.map((s) => (
						<SkillCard key={s.id} skill={s} />
					))}
				</ul>
			)}
		</section>
	)
}

/** One skill: the last 8 weeks against its target, the sessions, and the trail of worked on → next time. */
export function SkillPage({ skillId }: { skillId: string }) {
	const skill = useQuery(orpc.skills.get.queryOptions({ input: { id: skillId } }))
	const refresh = useRefresh()
	const toast = useToast()
	const navigate = useNavigate()
	const [editing, setEditing] = useState(false)
	const archive = useMutation({
		mutationFn: () => client.skills.archive({ id: skillId }),
		onSuccess: async () => {
			await refresh()
			await navigate({ to: '/mind/skills' })
			toast({ text: `Archived ${skill.data?.name}. Its sessions stay.`, undo: () => void client.skills.restore({ id: skillId }).then(refresh) })
		},
		onError: (error) => toast({ text: errorMessage(error) }),
	})
	const s = skill.data
	const top = Math.max(1, ...(s?.weeks.map((w) => w.minutes) ?? []), s?.weeklyMinutes ?? 0)
	return (
		<section className="mx-auto grid w-full max-w-3xl gap-6">
			<header className="grid gap-1">
				<Link to="/mind/skills" className="font-sans text-sm text-world-muted">
					← Skills
				</Link>
				{s && !editing && (
					<>
						<div className="flex flex-wrap items-center justify-between gap-3">
							<h1 className="text-3xl font-semibold tracking-tight">{s.name}</h1>
							{!s.archived && <LogPractice skillId={s.id} />}
						</div>
						{s.goal && <p className="text-lg text-world-muted">{s.goal}</p>}
						{s.archived && <p className="font-sans text-sm text-world-muted">Archived. Its sessions stay.</p>}
					</>
				)}
			</header>
			{skill.isError && <p role="alert">{errorMessage(skill.error)}</p>}
			{s && editing && (
				<SkillForm
					label="Change skill"
					initial={{ name: s.name, goal: s.goal ?? '', weeklyMinutes: s.weeklyMinutes ? String(s.weeklyMinutes) : '' }}
					onCancel={() => setEditing(false)}
					onSave={async (f) => {
						await client.skills.update({ id: s.id, name: f.name, goal: f.goal, weeklyMinutes: f.weeklyMinutes ? Number(f.weeklyMinutes) : null })
						await refresh()
						setEditing(false)
					}}
				/>
			)}
			{s && (
				<>
					<section aria-labelledby="skill-weeks" className="grid gap-3 rounded-2xl border border-world-line bg-world-card p-5">
						<div>
							<h2 id="skill-weeks" className="text-xl">
								Weeks
							</h2>
							<p className="font-sans text-sm" data-testid="skill-week">
								{weekLine(s)}
								{s.sessions > s.week.sessions && <span className="text-world-muted"> · {sessions(s.sessions)} in all</span>}
							</p>
						</div>
						<div className="relative h-32">
							<ol aria-label="Minutes by week" className="grid h-full grid-cols-8 items-end gap-2">
								{s.weeks.map((w) => (
									<li key={w.week.toISOString()} className="grid h-full items-end" title={`${w.minutes} min`}>
										<div className="rounded-t-md bg-world-accent" style={{ height: `${(w.minutes / top) * 100}%`, minHeight: w.minutes ? 4 : 0 }} />
										<span className="sr-only">
											Week of {day.format(w.week)}: {w.minutes} min
										</span>
									</li>
								))}
							</ol>
							{s.weeklyMinutes !== null && (
								<div aria-hidden className="pointer-events-none absolute inset-x-0 border-t-2 border-dashed border-red" style={{ bottom: `${(s.weeklyMinutes / top) * 100}%` }} />
							)}
						</div>
						<div className="grid grid-cols-8 gap-2 font-sans text-xs text-world-muted">
							{s.weeks.map((w, i) => (
								<span key={w.week.toISOString()} className="text-center">
									{i === s.weeks.length - 1 ? 'This week' : day.format(w.week)}
								</span>
							))}
						</div>
						{s.weeklyMinutes !== null && <p className="font-sans text-xs text-world-muted">The dashed line is your target: {s.weeklyMinutes} min a week.</p>}
					</section>

					<section aria-labelledby="skill-trail" className="grid gap-3">
						<h2 id="skill-trail" className="text-xl">
							Sessions
						</h2>
						{s.trail.length ? (
							<ol className="grid gap-3" aria-label="Sessions">
								{s.trail.map((t) => (
									<li key={t.entryId} data-testid="session" className="grid gap-1 rounded-2xl border border-world-line bg-world-card p-4">
										<p className="font-sans text-xs text-world-muted">
											{day.format(t.at)} · {t.minutes} min
										</p>
										{(t.workedOn || t.nextTime) && (
											<p className="text-lg leading-snug">
												{t.workedOn ?? 'Practice'}
												{t.nextTime && <span className="text-world-muted"> → next time: {t.nextTime}</span>}
											</p>
										)}
										{t.feedback && <p className="font-sans text-sm text-world-muted">How it went: {t.feedback}</p>}
										{t.learned && <p className="font-sans text-sm">Learned: {t.learned}</p>}
									</li>
								))}
							</ol>
						) : (
							<p className="rounded-2xl border border-world-line bg-world-card p-5 text-world-muted">No sessions yet. Log practice when you have practised.</p>
						)}
					</section>
					{!s.archived && !editing && (
						<div className="flex gap-2">
							<button type="button" className={small} onClick={() => setEditing(true)}>
								Change
							</button>
							<button type="button" className={small} disabled={archive.isPending} onClick={() => archive.mutate()}>
								Archive
							</button>
						</div>
					)}
				</>
			)}
		</section>
	)
}
