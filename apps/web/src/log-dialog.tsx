import type { Entry, Skill } from '@life-log-club/contract'
import { ENTRY_TYPES, type EntryType, MAX_PRACTICE_MINUTES } from '@life-log-club/domain'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { useLogEntry } from './entry-actions'
import { MOODS, PILLAR_DOT } from './entries'
import { orpc } from './rpc'

const TYPES: { type: EntryType; label: string }[] = [
	{ type: 'gym.set', label: 'Gym set' },
	{ type: 'meal', label: 'Meal' },
	{ type: 'sleep', label: 'Sleep' },
	{ type: 'meeting', label: 'Meeting' },
	{ type: 'mood', label: 'Mood' },
	{ type: 'moment', label: 'Moment' },
	{ type: 'lesson', label: 'Lesson' },
	{ type: 'practice', label: 'Practice' },
]

const input =
	'w-full rounded-lg border border-ink/15 bg-white px-3 py-2.5 text-base text-ink outline-none focus:border-navy focus:ring-2 focus:ring-navy/20'

function Field({ label, children }: { label: string; children: ReactNode }) {
	return (
		<label className="grid min-w-0 gap-1.5 text-sm">
			<span className="font-medium text-ink/70">{label}</span>
			{children}
		</label>
	)
}

/** The last entry of each type, so a new one starts from the same values. */
function useLastOfEach() {
	const recent = useQuery(orpc.entries.list.queryOptions({ input: { limit: 100 } }))
	const last = new Map<EntryType, Entry>()
	for (const e of recent.data ?? []) if (!last.has(e.type)) last.set(e.type, e)
	const people = [...new Set((recent.data ?? []).flatMap((e) => (e.type === 'meeting' ? [e.details.person] : [])))]
	return { last, people }
}

type Form = {
	exercise: string
	weightKg: string
	reps: string
	name: string
	proteinG: string
	hours: string
	person: string
	text: string
	cue: string
	remember: boolean
	skillId: string
	minutes: string
	workedOn: string
	feedback: string
	nextTime: string
}

/** A first session lasts this long, until the skill has one to start from. */
const FIRST_SESSION_MINUTES = 30

/**
 * A practice session starts from the skill's last one: its minutes, and its Next time as this
 * session's focus, so focus, feedback and fix carry on with no typing.
 */
const practiceFrom = (skill: Skill | undefined) => ({
	skillId: skill?.id ?? '',
	minutes: String(skill?.last?.minutes ?? FIRST_SESSION_MINUTES),
	workedOn: skill?.last?.nextTime ?? '',
	feedback: '',
	nextTime: '',
})

function defaults(last: Map<EntryType, Entry>, skills: Skill[], skillId: string | undefined): Form {
	const practised = last.get('practice')
	// The skill asked for, else the one practised last, else the first.
	const skill = skills.find((k) => k.id === skillId) ?? skills.find((k) => practised?.type === 'practice' && k.id === practised.details.skillId) ?? skills[0]
	const set = last.get('gym.set')
	const meal = last.get('meal')
	const sleep = last.get('sleep')
	const meeting = last.get('meeting')
	return {
		exercise: set?.type === 'gym.set' ? set.details.exercise : '',
		weightKg: set?.type === 'gym.set' ? String(set.details.weightKg) : '',
		reps: set?.type === 'gym.set' ? String(set.details.reps) : '',
		name: meal?.type === 'meal' ? meal.details.name : '',
		proteinG: meal?.type === 'meal' ? String(meal.details.proteinG) : '',
		hours: sleep?.type === 'sleep' ? String(sleep.details.hours) : '',
		person: meeting?.type === 'meeting' ? meeting.details.person : '',
		text: '',
		cue: '',
		remember: true,
		...practiceFrom(skill),
	}
}

/**
 * Quick capture for every kind of log. It starts from the last values of the chosen type, so
 * most logs are one click on Save; a mood is one click on its face.
 */
export function LogDialog({ type: openWith, skillId, onClose }: { type: EntryType | null; skillId?: string; onClose: () => void }) {
	const ref = useRef<HTMLDialogElement>(null)
	const [type, setType] = useState<EntryType>('gym.set')
	const { last, people } = useLastOfEach()
	const skills = useQuery(orpc.skills.list.queryOptions()).data ?? []
	const [form, setForm] = useState<Form>(() => defaults(last, skills, skillId))
	const log = useLogEntry()

	useEffect(() => {
		const dialog = ref.current
		if (!dialog) return
		if (openWith && !dialog.open) {
			setType(openWith)
			setForm(defaults(last, skills, skillId))
			log.reset()
			dialog.showModal()
		}
		if (!openWith && dialog.open) dialog.close()
		// Defaults are read once, when the dialog opens.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [openWith])

	// Skills can load after the dialog opened: practice then starts from the first skill.
	useEffect(() => {
		if (type === 'practice' && skills.length && !skills.some((k) => k.id === form.skillId)) setForm((f) => ({ ...f, ...practiceFrom(skills[0]) }))
	}, [type, skills, form.skillId])

	const set = (key: keyof Form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value }))
	const save = (data: Parameters<typeof log.mutate>[0]) => log.mutate(data, { onSuccess: onClose })
	const text = form.text.trim() || undefined

	function submit() {
		switch (type) {
			case 'gym.set':
				return save({ type, details: { exercise: form.exercise, weightKg: Number(form.weightKg), reps: Number(form.reps) } })
			case 'meal':
				return save({ type, details: { name: form.name, proteinG: Number(form.proteinG) } })
			case 'sleep':
				return save({ type, details: { hours: Number(form.hours) } })
			case 'meeting':
				return save({ type, details: { person: form.person }, text })
			case 'moment':
				return save({ type, details: {}, text })
			case 'lesson': {
				const cue = form.cue.trim()
				return save({ type, details: cue ? { cue } : {}, text, remember: form.remember })
			}
			case 'practice': {
				const optional = (v: string) => v.trim() || undefined
				return save({
					type,
					details: { skillId: form.skillId, minutes: Number(form.minutes), workedOn: optional(form.workedOn), feedback: optional(form.feedback), nextTime: optional(form.nextTime) },
					text,
				})
			}
			case 'mood':
				return
		}
	}

	return (
		<dialog
			ref={ref}
			aria-labelledby="log-title"
			onClose={onClose}
			onClick={(e) => e.target === ref.current && onClose()}
			className="m-auto w-[min(100%-2rem,32rem)] rounded-2xl bg-white p-0 text-ink shadow-2xl backdrop:bg-navy/40"
		>
			<form
				className="grid gap-5 p-5"
				onSubmit={(e) => {
					e.preventDefault()
					submit()
				}}
			>
				<div className="flex items-center justify-between">
					<h2 id="log-title" className="text-lg font-semibold">
						Log
					</h2>
					<button type="button" onClick={onClose} className="rounded-lg px-2 py-1 text-sm text-ink/60 hover:bg-ink/5">
						Close <kbd className="ml-1 rounded border border-ink/15 px-1 text-xs">Esc</kbd>
					</button>
				</div>
				<div role="radiogroup" aria-label="What to log" className="flex flex-wrap gap-2">
					{TYPES.map((t) => (
						<button
							key={t.type}
							type="button"
							role="radio"
							aria-checked={type === t.type}
							onClick={() => setType(t.type)}
							className="flex items-center gap-2 rounded-full border border-ink/15 px-3 py-1.5 text-sm transition hover:bg-ink/5 aria-checked:border-navy aria-checked:bg-navy aria-checked:text-white"
						>
							<span className={`size-2 rounded-full ${PILLAR_DOT[ENTRY_TYPES[t.type].pillar]}`} />
							{t.label}
						</button>
					))}
				</div>

				{type === 'gym.set' && (
					<div className="grid grid-cols-[1fr_6rem_5rem] gap-3">
						<Field label="Exercise">
							<input className={input} required value={form.exercise} onChange={set('exercise')} placeholder="Bench press" />
						</Field>
						<Field label="Weight (kg)">
							<input className={input} required type="number" inputMode="decimal" min={0} step={0.5} value={form.weightKg} onChange={set('weightKg')} />
						</Field>
						<Field label="Reps">
							<input className={input} required type="number" inputMode="numeric" min={1} step={1} value={form.reps} onChange={set('reps')} />
						</Field>
					</div>
				)}
				{type === 'meal' && (
					<div className="grid grid-cols-[1fr_7rem] gap-3">
						<Field label="What">
							<input className={input} required value={form.name} onChange={set('name')} placeholder="Protein shake" />
						</Field>
						<Field label="Protein (g)">
							<input className={input} required type="number" inputMode="decimal" min={0} value={form.proteinG} onChange={set('proteinG')} />
						</Field>
					</div>
				)}
				{type === 'sleep' && (
					<Field label="Hours slept">
						<input className={input} required type="number" inputMode="decimal" min={0} max={24} step={0.25} value={form.hours} onChange={set('hours')} />
					</Field>
				)}
				{type === 'meeting' && (
					<>
						<Field label="Who">
							<input className={input} required list="people" value={form.person} onChange={set('person')} placeholder="Kabir" />
							<datalist id="people">
								{people.map((p) => (
									<option key={p} value={p} />
								))}
							</datalist>
						</Field>
						<Field label="What you talked about">
							<textarea className={`${input} min-h-24`} value={form.text} onChange={set('text')} />
						</Field>
						<p className="-mt-3 text-xs text-ink/60">Notes about people are encrypted.</p>
					</>
				)}
				{type === 'moment' && (
					<Field label="What happened">
						<textarea className={`${input} min-h-24`} required value={form.text} onChange={set('text')} />
					</Field>
				)}
				{type === 'lesson' && (
					<>
						<Field label="What did you learn?">
							<textarea className={`${input} min-h-24`} required value={form.text} onChange={set('text')} />
						</Field>
						<Field label="When does it apply? (optional)">
							<input className={input} maxLength={80} value={form.cue} onChange={set('cue')} placeholder="Salary talks" />
						</Field>
						<label className="-mt-2 flex items-center gap-2 text-sm text-ink/80">
							<input
								type="checkbox"
								className="size-4 accent-navy"
								checked={form.remember}
								onChange={(e) => setForm((f) => ({ ...f, remember: e.target.checked }))}
							/>
							Remember this: bring it back in Review
						</label>
					</>
				)}
				{type === 'practice' &&
					(skills.length ? (
						<>
							<div className="grid grid-cols-[1fr_6rem] gap-3">
								<Field label="Skill">
									<select
										className={input}
										value={form.skillId}
										onChange={(e) => setForm((f) => ({ ...f, ...practiceFrom(skills.find((k) => k.id === e.target.value)) }))}
									>
										{skills.map((k) => (
											<option key={k.id} value={k.id}>
												{k.name}
											</option>
										))}
									</select>
								</Field>
								<Field label="Minutes">
									<input className={input} required type="number" inputMode="numeric" min={1} max={MAX_PRACTICE_MINUTES} step={1} value={form.minutes} onChange={set('minutes')} />
								</Field>
							</div>
							<Field label="Worked on">
								<input className={input} maxLength={300} value={form.workedOn} onChange={set('workedOn')} placeholder="The one thing this session is for" />
							</Field>
							{form.workedOn && form.workedOn === skills.find((k) => k.id === form.skillId)?.last?.nextTime && (
								<p className="-mt-3 text-xs text-ink/60">From last time’s Next time.</p>
							)}
							<Field label="What told you how it went">
								<input className={input} maxLength={300} value={form.feedback} onChange={set('feedback')} placeholder="A recording, a teacher, the metronome" />
							</Field>
							<Field label="Next time">
								<input className={input} maxLength={300} value={form.nextTime} onChange={set('nextTime')} placeholder="The fix to try next" />
							</Field>
							<Field label="One thing I learned (optional)">
								<textarea className={`${input} min-h-16`} value={form.text} onChange={set('text')} />
							</Field>
							<p className="-mt-3 text-xs text-ink/60">What you learned comes back in Review.</p>
						</>
					) : (
						<p className="text-sm text-ink/80">
							Add a skill first, such as piano or public speaking.{' '}
							<Link to="/mind/skills" onClick={onClose} className="font-medium text-navy underline underline-offset-2">
								Add a skill
							</Link>
						</p>
					))}
				{type === 'mood' ? (
					<div role="group" aria-label="How do you feel?" className="grid grid-cols-5 gap-2">
						{MOODS.map((label, i) => (
							<button
								key={label}
								type="button"
								disabled={log.isPending}
								onClick={() => save({ type: 'mood', details: { score: i + 1 } })}
								className="grid justify-items-center gap-1 rounded-xl border border-ink/10 py-3 text-sm transition hover:border-heart hover:bg-heart/10 active:scale-95"
							>
								<span aria-hidden className="text-xl">{['😞', '😕', '😐', '🙂', '😄'][i]}</span>
								{label}
							</button>
						))}
					</div>
				) : type === 'practice' && !skills.length ? null : (
					<button
						type="submit"
						disabled={log.isPending}
						className="rounded-lg bg-red px-4 py-2.5 font-semibold text-white transition hover:bg-red/90 active:scale-[0.98] disabled:opacity-60"
					>
						{log.isPending ? 'Saving…' : 'Save'}
					</button>
				)}
			</form>
		</dialog>
	)
}
