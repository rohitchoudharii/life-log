import { Block, EntryData, EntryText, Note, PILLARS } from '@life-log-club/domain'
import { oc } from '@orpc/contract'
import { z } from 'zod'

const Email = z.email().trim().toLowerCase()

/** At least 10 characters; length matters more than symbols. */
export const Password = z.string().min(10, 'Use at least 10 characters').max(200)

export const User = z.object({ id: z.uuid(), email: z.string(), name: z.string() })
export type User = z.infer<typeof User>

export const Device = z.object({
	id: z.uuid(),
	label: z.string(),
	current: z.boolean(),
	createdAt: z.date(),
	lastSeenAt: z.date(),
})
export type Device = z.infer<typeof Device>

export const Entry = EntryData.and(
	z.object({
		id: z.uuid(),
		pillar: z.enum(PILLARS),
		jobs: z.array(z.enum(['remember', 'relive', 'track'])),
		occurredAt: z.date(),
		text: z.string().nullable(),
		createdAt: z.date(),
	}),
)
export type Entry = z.infer<typeof Entry>

export const Card = z.object({
	id: z.uuid(),
	kind: z.enum(['idea', 'lesson']),
	prompt: z.string(),
	answer: z.string(),
	entryId: z.uuid().nullable(),
	dueAt: z.date(),
})
export type Card = z.infer<typeof Card>

export const AiKey = z.object({ provider: z.enum(['anthropic', 'openai']), model: z.string(), last4: z.string() })
export type AiKey = z.infer<typeof AiKey>

/** A `reference` section (a bibliography) is kept to read, with no questions and outside progress. */
const SectionKind = z.enum(['body', 'reference'])

export const Reading = z.object({
	id: z.uuid(),
	title: z.string(),
	author: z.string().nullable(),
	/** The page's own address once it is imported; null while importing. */
	sourceUrl: z.string().nullable(),
	/** The link as the member added it. */
	requestedUrl: z.string().nullable(),
	status: z.enum(['importing', 'ready', 'failed']),
	/** Why the import failed, written for the member. */
	error: z.string().nullable(),
	wordCount: z.int(),
	/** Sections to read and recall; reference sections are not counted. */
	sectionCount: z.int(),
	/** While a web book is imported: how many of its pages are done. Null for everything else. */
	progress: z.object({ done: z.int(), total: z.int() }).nullable(),
	createdAt: z.date(),
})
export type Reading = z.infer<typeof Reading>

export const ReadingWithContents = Reading.extend({
	/** Every section in reading order; `level` 1 to 3 nests them into a tree. */
	contents: z.array(
		z.object({
			id: z.uuid(),
			position: z.int(),
			level: z.int(),
			title: z.string(),
			aiTitle: z.boolean(),
			wordCount: z.int(),
			kind: SectionKind,
		}),
	),
})
export type ReadingWithContents = z.infer<typeof ReadingWithContents>

export const Section = z.object({
	id: z.uuid(),
	readingId: z.uuid(),
	position: z.int(),
	level: z.int(),
	title: z.string(),
	/** True when the AI wrote the title, because the article had no headings of its own. */
	aiTitle: z.boolean(),
	kind: SectionKind,
	/**
	 * True while the member's AI adds headings to this long chapter, which opening it asked for.
	 * The reading's contents change when they are added. Never true for a member with no AI key:
	 * the chapter stays cut by length.
	 */
	headingsPending: z.boolean(),
	blocks: z.array(Block),
	/** The footnotes and endnotes the blocks' note markers open. */
	notes: z.array(Note),
	/** The page this section came from, for a web book; null when it is the reading's own page or file. */
	sourceUrl: z.string().nullable(),
})
export type Section = z.infer<typeof Section>

/** The largest EPUB or PDF a member can add. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024
export const FILE_TOO_LARGE = 'This file is larger than 25 MB. Try a smaller copy.'

const EntryId = z.object({ id: z.uuid() })
const Ok = z.object({ ok: z.literal(true) })

export const contract = {
	system: {
		health: oc.output(z.object({ server: z.literal('ok'), database: z.enum(['ok', 'down']) })),
	},
	auth: {
		/** The signed-in user, or why there is none. Never throws for a missing session. */
		me: oc.output(
			z.object({ user: User.nullable(), reason: z.enum(['signed-out', 'expired']).nullable() }),
		),
		/** The email an unused invite link is for, so the welcome page can show who signs in with it. */
		checkInvite: oc.input(z.object({ token: z.string().min(1) })).output(z.object({ email: z.string() })),
		acceptInvite: oc
			.input(z.object({ token: z.string().min(1), name: z.string().trim().min(1).max(80), password: Password }))
			.output(User),
		signIn: oc.input(z.object({ email: Email, password: z.string().min(1).max(200) })).output(User),
		signOut: oc.output(z.object({ ok: z.literal(true) })),
	},
	devices: {
		list: oc.output(z.array(Device)),
		signOut: oc.input(EntryId).output(Ok),
	},
	entries: {
		/**
		 * The client picks the id, so it can show the entry at once and safely retry: creating the
		 * same id twice returns the first entry.
		 */
		create: oc
			.input(EntryData.and(z.object({ id: z.uuid(), occurredAt: z.date().optional(), text: EntryText.optional() })))
			.output(Entry),
		list: oc
			.input(
				z.object({
					pillar: z.enum(PILLARS).optional(),
					before: z.date().optional(),
					limit: z.int().min(1).max(100).default(50),
				}),
			)
			.output(z.array(Entry)),
		update: oc
			.input(
				z.object({
					id: z.uuid(),
					occurredAt: z.date().optional(),
					text: EntryText.nullable().optional(),
					details: z.record(z.string(), z.unknown()).optional(),
				}),
			)
			.output(Entry),
		/** Hides the entry; `restore` brings it back (undo). Removed entries are deleted for good after 30 days. */
		remove: oc.input(EntryId).output(Ok),
		restore: oc.input(EntryId).output(Entry),
	},
	review: {
		/** Adds an idea or a lesson to spaced review. It is due at once. The client picks the id. */
		add: oc
			.input(
				z.object({
					id: z.uuid(),
					kind: z.enum(['idea', 'lesson']),
					prompt: z.string().trim().min(1).max(1000),
					answer: z.string().trim().min(1).max(5000),
					entryId: z.uuid().optional(),
				}),
			)
			.output(Card),
		/** Cards due now, oldest first, and how many are due in total. */
		due: oc
			.input(z.object({ limit: z.int().min(1).max(100).default(20) }))
			.output(z.object({ cards: z.array(Card), total: z.int() })),
		/** Records how well a due card was remembered and returns when it comes back. */
		answer: oc
			.input(z.object({ id: z.uuid(), rating: z.enum(['again', 'hard', 'good', 'easy']) }))
			.output(z.object({ dueAt: z.date() })),
	},
	readings: {
		/**
		 * Adds a link to read. The reading comes back at once as `importing`, and the server
		 * fetches the page in the background. The client picks the id. Adding a link the member
		 * already has returns that reading instead, so the id that comes back can differ; a
		 * removed one is restored, and a failed one is tried again.
		 */
		add: oc.input(z.object({ id: z.uuid(), url: z.string().trim().min(1, 'Paste a link').max(2000) })).output(Reading),
		/**
		 * Adds an EPUB or PDF file, which the server reads in the background, like `add`. The file
		 * type comes from its bytes, not its name. The same file added twice is one reading.
		 */
		addFile: oc.input(z.object({ id: z.uuid(), file: z.file().max(MAX_FILE_BYTES, FILE_TOO_LARGE) })).output(Reading),
		/** The member's readings, newest first. */
		list: oc.output(z.array(Reading)),
		/**
		 * One reading with its contents. A link that turned out to be a page the member already
		 * has returns that reading, with its own id.
		 */
		get: oc.input(EntryId).output(ReadingWithContents),
		/** One section's text. */
		section: oc.input(EntryId).output(Section),
		/** Hides the reading; `restore` brings it back (undo). Removed readings are deleted for good after 30 days. */
		remove: oc.input(EntryId).output(Ok),
		restore: oc.input(EntryId).output(Reading),
	},
	ai: {
		/** The member's own Anthropic or OpenAI key, never sent back in full. */
		getKey: oc.output(AiKey.nullable()),
		/** Checks the key with the provider, picks a low-cost model, and stores the key encrypted. */
		saveKey: oc
			.input(z.object({ provider: AiKey.shape.provider, apiKey: z.string().trim().min(10, 'Paste the whole key').max(500) }))
			.output(AiKey),
		removeKey: oc.output(Ok),
	},
}

export type Contract = typeof contract
