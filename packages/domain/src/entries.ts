import { z } from 'zod'

/**
 * Every log is an entry. Each type has its own details; everything else (time, text, pillar)
 * is shared, so one list of entries feeds history, search and look-back for every pillar.
 * To add a kind of log, add a variant here and a line to ENTRY_TYPES.
 */
/** The longest practice session one entry logs: 10 hours. */
export const MAX_PRACTICE_MINUTES = 600

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
	z.object({
		type: z.literal('lesson'),
		// When the lesson applies ("Salary talks"): the cue its review card asks with.
		details: z.object({ cue: z.string().trim().min(1).max(80).optional() }),
	}),
	z.object({
		// A practice session on a skill. Its text is the one thing learned, which becomes a lesson card.
		type: z.literal('practice'),
		details: z.object({
			skillId: z.uuid(),
			/** The skill's name, set by the server, so lists show it without another lookup. */
			skill: z.string().max(80).optional(),
			minutes: z.int().min(1, 'Practise for at least a minute.').max(MAX_PRACTICE_MINUTES, 'Log at most 10 hours at a time.'),
			/** The focus of this session; prefilled from the last session's Next time. */
			workedOn: z.string().trim().max(300).optional(),
			/** What told the learner how it went: a recording, a teacher, a metronome. */
			feedback: z.string().trim().max(300).optional(),
			/** The fix for next time, which becomes the next session's focus. */
			nextTime: z.string().trim().max(300).optional(),
		}),
	}),
	z.object({
		// Made by Finished on a reading, never from + Log. The text holds its key lessons, one a line.
		type: z.literal('reading.finished'),
		details: z.object({ readingId: z.uuid(), title: z.string().max(500), author: z.string().max(500).optional() }),
	}),
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
	practice: { pillar: 'mind', jobs: ['track', 'remember'], privateText: false },
	'reading.finished': { pillar: 'mind', jobs: ['relive', 'track'], privateText: false },
}

export const EntryText = z.string().trim().max(5000)
