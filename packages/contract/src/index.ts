import { Block, EntryData, EntryText, Note, PILLARS, WRITE_STATUSES } from '@life-log-club/domain'
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
	kind: z.enum(['idea', 'lesson', 'word']),
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

/** A place in a reading: a section, and the block of it at the top of the screen (from 0). */
export const ReadingPosition = z.object({ sectionId: z.uuid(), block: z.int().min(0) })
export type ReadingPosition = z.infer<typeof ReadingPosition>

/**
 * Active seconds in one section before it counts as seen: then its key ideas are worth writing.
 * The reader also sends a heartbeat of this many seconds to `readings.seen` while it is read.
 */
export const SEEN_SECONDS = 30

/** How the app works for one member. Every field has a default, so a new member has them all. */
export const Preferences = z.object({
	/** Background AI work pauses once this month's estimated spend reaches it, in US dollars. */
	aiMonthlyBudgetUsd: z.number().min(0, 'The budget can’t be below $0.').max(1000, 'Choose a budget of $1,000 or less.'),
})
export type Preferences = z.infer<typeof Preferences>

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
	/** For a chapter page of a web book: the book it belongs to, which `addBook` adds whole. */
	partOfBook: z.object({ title: z.string(), pages: z.int() }).nullable(),
	/**
	 * `url` is an article from a link and `web_capture` one the extension saved from the member's
	 * browser: the only kinds of reading a member's book can hold.
	 */
	source: z.enum(['url', 'pdf_url', 'web_book', 'web_capture', 'epub', 'pdf_upload']),
	/** When the member reached the end of its last section. */
	readAt: z.date().nullable(),
	/** Where the member stopped reading, which opening the reading goes back to; null before they open it. */
	position: ReadingPosition.nullable(),
	/** The member's book this reading is a chapter of. */
	book: z.object({ id: z.uuid(), title: z.string() }).nullable(),
	createdAt: z.date(),
})
export type Reading = z.infer<typeof Reading>

/** A book the member made from articles; its chapters are readings, in the member's order. */
export const Book = z.object({
	id: z.uuid(),
	title: z.string(),
	author: z.string().nullable(),
	chapterCount: z.int(),
	readCount: z.int(),
	/** The first chapter not read yet, which Continue opens; null when every chapter is read. */
	continueId: z.uuid().nullable(),
	createdAt: z.date(),
})
export type Book = z.infer<typeof Book>
export const BookWithChapters = Book.extend({ chapters: z.array(Reading) })
export type BookWithChapters = z.infer<typeof BookWithChapters>
const BookTitle = z.string().trim().min(1, 'Give the book a title').max(200)

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
			/** When the end of the section was first on the member's screen. */
			readAt: z.date().nullable(),
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
	/**
	 * Where writing its key ideas and questions stands. Writing starts after `SEEN_SECONDS` in the
	 * section. `needs_key`: the member has no AI key; `paused`: this month's AI budget is used.
	 */
	writeStatus: z.enum(WRITE_STATUSES),
	/** How many key ideas the AI found in it. */
	keyIdeas: z.int(),
})
export type Section = z.infer<typeof Section>

/** Limits on a page the extension saves: its HTML, and the images read in the member's tab. */
export const MAX_CAPTURE_HTML_CHARS = 5 * 1024 * 1024
export const MAX_CAPTURE_IMAGES = 40
export const MAX_CAPTURE_IMAGE_BYTES = 5 * 1024 * 1024
export const MAX_CAPTURE_IMAGES_BYTES = 20 * 1024 * 1024

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
		/**
		 * Adds the whole web book a chapter reading (`id`) is part of, as a new reading the client
		 * picks the id of (`bookId`), imported like `add`. The chapter then opens the book. A book
		 * the member already has is returned instead, like `add`.
		 */
		addBook: oc.input(z.object({ id: z.uuid(), bookId: z.uuid() })).output(Reading),
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
		/**
		 * Saves a page from the member's own browser (the extension), for pages the server can't
		 * open, such as one behind a login. `html` is the rendered page and `images` the bytes of
		 * its images, read in the tab, by the address they load from; the server never fetches
		 * the page. Saving the same page again replaces it and marks it not read. `bookId` puts
		 * it in that book, and null takes it out of any. The client picks the id of a new reading.
		 */
		capture: oc
			.input(
				z.object({
					id: z.uuid(),
					url: z.string().trim().min(1).max(2000),
					html: z.string().max(MAX_CAPTURE_HTML_CHARS, 'This page is too large to save.'),
					bookId: z.uuid().nullable(),
					images: z
						.array(z.object({ src: z.string().max(4000), file: z.file().max(MAX_CAPTURE_IMAGE_BYTES) }))
						.max(MAX_CAPTURE_IMAGES)
						.refine((images) => images.reduce((n, i) => n + i.file.size, 0) <= MAX_CAPTURE_IMAGES_BYTES, 'These images are too large to save.'),
				}),
			)
			.output(z.object({ reading: Reading, updated: z.boolean() })),
		/**
		 * What the extension's popup needs before Save: the reading already saved from this page
		 * and its words, and the book to offer: the page's own book, else the book the member last
		 * added to from the same site, with the usual length of its chapters.
		 */
		captureTarget: oc.input(z.object({ url: z.string().trim().min(1).max(2000) })).output(
			z.object({
				readingId: z.uuid().nullable(),
				words: z.int().nullable(),
				book: z.object({ id: z.uuid(), title: z.string() }).nullable(),
				bookWords: z.int().nullable(),
			}),
		),
		/**
		 * Marks a section read: its end was on the member's screen. Reaching the end of the last
		 * section marks the whole reading read. The first time counts.
		 */
		markRead: oc.input(z.object({ id: z.uuid(), sectionId: z.uuid() })).output(Ok),
		/** Saves where the member is in a reading, which opening it next time goes back to. The last save wins. */
		savePosition: oc.input(ReadingPosition.extend({ id: z.uuid() })).output(Ok),
		/**
		 * A heartbeat while the member reads a section: `seconds` of active reading, sent every
		 * `SEEN_SECONDS`. The first one marks the section seen; each adds to the day's reading time.
		 */
		seen: oc.input(z.object({ sectionId: z.uuid(), seconds: z.int().min(1).max(120) })).output(Ok),
	},
	books: {
		/** Makes an empty book. The client picks the id, so a retry makes one book. */
		create: oc.input(z.object({ id: z.uuid(), title: BookTitle })).output(Book),
		/** The member's books, newest first. */
		list: oc.output(z.array(Book)),
		get: oc.input(EntryId).output(BookWithChapters),
		rename: oc.input(z.object({ id: z.uuid(), title: BookTitle })).output(Book),
		/** Hides the book; its chapters show as articles again until `restore` (undo). */
		remove: oc.input(EntryId).output(Ok),
		restore: oc.input(EntryId).output(Book),
		/** Adds an article to the end of the book; one in another book moves here. Only articles from links. */
		addChapter: oc.input(z.object({ bookId: z.uuid(), readingId: z.uuid() })).output(BookWithChapters),
		/** Takes the chapter out of its book; it stays as an article, with everything read and recalled. */
		removeChapter: oc.input(z.object({ readingId: z.uuid() })).output(Ok),
		/** Moves the chapter to `to` (from 0) in its book. */
		moveChapter: oc.input(z.object({ readingId: z.uuid(), to: z.int().min(0) })).output(BookWithChapters),
	},
	ai: {
		/** The member's own Anthropic or OpenAI key, never sent back in full. */
		getKey: oc.output(AiKey.nullable()),
		/** Checks the key with the provider, picks a low-cost model, and stores the key encrypted. */
		saveKey: oc
			.input(z.object({ provider: AiKey.shape.provider, apiKey: z.string().trim().min(10, 'Paste the whole key').max(500) }))
			.output(AiKey),
		removeKey: oc.output(Ok),
		/**
		 * This month's AI calls (calendar month, UTC) and their estimated cost against the member's
		 * budget. `costUsd` is null when no call was to a model with a known price. Once `reached`,
		 * background AI work pauses until next month or a higher budget.
		 */
		usage: oc.output(
			z.object({ calls: z.int(), tokens: z.int(), costUsd: z.number().nullable(), budgetUsd: z.number(), reached: z.boolean() }),
		),
	},
	preferences: {
		get: oc.output(Preferences),
		/** Changes the preferences given and returns them all. */
		update: oc.input(Preferences.partial()).output(Preferences),
	},
}

export type Contract = typeof contract
