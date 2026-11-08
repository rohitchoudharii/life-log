import { z } from 'zod'

/**
 * Every log is an entry. Each type has its own details; everything else (time, text, pillar)
 * is shared, so one list of entries feeds history, search and look-back for every pillar.
 * To add a kind of log, add a variant here and a line to ENTRY_TYPES.
 */
export const EntryData = z.discriminatedUnion('type', [
	z.object({
		type: z.literal('gym.set'),
		details: z.object({
			exercise: z.string().trim().min(1).max(80),
			weightKg: z.number().min(0).max(1000),
			reps: z.int().min(1).max(1000),
		}),
	}),
	z.object({
		type: z.literal('meal'),
		details: z.object({ name: z.string().trim().min(1).max(80), proteinG: z.number().min(0).max(500) }),
	}),
	z.object({ type: z.literal('sleep'), details: z.object({ hours: z.number().min(0).max(24) }) }),
	z.object({ type: z.literal('mood'), details: z.object({ score: z.int().min(1).max(5) }) }),
	z.object({ type: z.literal('meeting'), details: z.object({ person: z.string().trim().min(1).max(80) }) }),
	z.object({ type: z.literal('moment'), details: z.object({}) }),
	z.object({ type: z.literal('lesson'), details: z.object({}) }),
])
export type EntryData = z.infer<typeof EntryData>
export type EntryType = EntryData['type']

/** What the app does with an entry: bring it back for recall, for looking back, or count it. */
export type EntryJob = 'remember' | 'relive' | 'track'

type EntryTypeInfo = {
	pillar: 'mind' | 'body' | 'heart' | 'path'
	jobs: EntryJob[]
	/** The text holds notes about other people, so it is encrypted in the database. */
	privateText: boolean
}

export const ENTRY_TYPES: Record<EntryType, EntryTypeInfo> = {
	'gym.set': { pillar: 'body', jobs: ['track'], privateText: false },
	meal: { pillar: 'body', jobs: ['track'], privateText: false },
	sleep: { pillar: 'body', jobs: ['track'], privateText: false },
	mood: { pillar: 'heart', jobs: ['track'], privateText: false },
	meeting: { pillar: 'heart', jobs: ['relive'], privateText: true },
	moment: { pillar: 'heart', jobs: ['relive'], privateText: false },
	lesson: { pillar: 'mind', jobs: ['remember'], privateText: false },
}

export const EntryText = z.string().trim().max(5000)
