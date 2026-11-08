import type { Entry } from '@life-log-club/contract'
import type { Pillar } from '@life-log-club/domain'

export const PILLAR_NAMES: Record<Pillar, string> = { mind: 'Mind', body: 'Body', heart: 'Heart', path: 'Path' }
export const PILLAR_DOT: Record<Pillar, string> = { mind: 'bg-mind', body: 'bg-body', heart: 'bg-heart', path: 'bg-path' }

export const MOODS = ['Low', 'Meh', 'Okay', 'Good', 'Great'] as const

const kg = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(1)} kg`

/** One line that says what was logged. */
export function describe(e: Entry) {
	switch (e.type) {
		case 'gym.set':
			return `${e.details.exercise} · ${kg(e.details.weightKg)} × ${e.details.reps}`
		case 'meal':
			return `${e.details.name} · ${e.details.proteinG} g protein`
		case 'sleep':
			return `Slept ${e.details.hours} h`
		case 'mood':
			return `Mood: ${MOODS[e.details.score - 1]}`
		case 'meeting':
			return `Met ${e.details.person}`
		case 'moment':
			return e.text ?? 'A moment'
		case 'lesson':
			return e.text ?? 'A lesson'
	}
}

/** The note under the main line, when there is one the main line doesn't already show. */
export const note = (e: Entry) => (e.type === 'moment' || e.type === 'lesson' ? null : e.text)

const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' })
const day = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' })

export function when(date: Date, now = new Date()) {
	const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
	const days = Math.round((startOf(now) - startOf(date)) / 86_400_000)
	if (days === 0) return `Today ${time.format(date)}`
	if (days === 1) return `Yesterday ${time.format(date)}`
	if (days < 7) return `${days} days ago`
	return day.format(date)
}

export const isToday = (date: Date) => date.toDateString() === new Date().toDateString()
