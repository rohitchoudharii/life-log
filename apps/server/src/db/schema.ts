import type { Block, Confidence, Note, PointStatus, QuestionLevel, Rating, RecallStatus, ReviewState, SectionKind, WriteStatus } from '@life-log-club/domain'
import type { Reveal } from '@life-log-club/contract'
import { type AnyColumn, sql } from 'drizzle-orm'
import {
	type AnyPgColumn,
	customType,
	bigint,
	boolean,
	date,
	index,
	integer,
	jsonb,
	numeric,
	pgPolicy,
	pgTable,
	primaryKey,
	real,
	smallint,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from 'drizzle-orm/pg-core'

const id = () => uuid().primaryKey().defaultRandom()
/** Raw bytes, such as an uploaded book or a stored image. */
const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' })
const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow()

// Sign-in tables are read before anyone is known (by email or session token), so they have no
// row-level security. Only the auth module touches them.

export const users = pgTable('users', {
	id: id(),
	email: text().notNull().unique(),
	name: text().notNull(),
	/** Null until the person opens their invite link and picks a password. */
	passwordHash: text(),
	createdAt: createdAt(),
	disabledAt: timestamp({ withTimezone: true }),
})

/** An invite link sets or resets the password for one email. Only the owner makes them, from the command line. */
export const invites = pgTable('invites', {
	id: id(),
	email: text().notNull(),
	tokenHash: text().notNull().unique(),
	expiresAt: timestamp({ withTimezone: true }).notNull(),
	usedAt: timestamp({ withTimezone: true }),
	createdAt: createdAt(),
})

/** One row per signed-in browser or device; this is the device list. */
export const sessions = pgTable(
	'sessions',
	{
		id: id(),
		userId: uuid()
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		tokenHash: text().notNull().unique(),
		label: text().notNull(),
		createdAt: createdAt(),
		lastSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
		revokedAt: timestamp({ withTimezone: true }),
	},
	(t) => [index().on(t.userId)],
)

/** Every sign-in event. The app account can add and read rows, never change or delete them. */
export const auditLog = pgTable(
	'audit_log',
	{
		id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
		event: text().notNull(),
		userId: uuid(),
		email: text(),
		ip: text(),
		userAgent: text(),
		meta: jsonb().$type<Record<string, unknown>>(),
		at: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [index().on(t.event, t.email, t.at), index().on(t.event, t.ip, t.at)],
)

/** The member whose data a transaction may touch, set by `asUser`. Row-level security checks it. */
const currentUser = sql`nullif(current_setting('app.user_id', true), '')::uuid`

/** Row-level security: a member sees and changes only rows with their own user id. */
const ownRows = (userId: AnyColumn) =>
	pgPolicy('own_rows', { for: 'all', using: sql`${userId} = ${currentUser}`, withCheck: sql`${userId} = ${currentUser}` })

export const entries = pgTable(
	'entries',
	{
		/** Chosen by the client, so a retried create can't make a duplicate. */
		id: uuid().primaryKey(),
		userId: uuid()
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		type: text().notNull(),
		pillar: text().notNull(),
		occurredAt: timestamp({ withTimezone: true }).notNull(),
		/** Plain text, for entry types whose text isn't private. */
		text: text(),
		/** Encrypted text, for entry types whose text is about other people. */
		textCt: text(),
		details: jsonb().$type<Record<string, unknown>>().notNull(),
		createdAt: createdAt(),
		updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
		deletedAt: timestamp({ withTimezone: true }),
	},
	(t) => [
		index().on(t.userId, t.occurredAt.desc()),
		pgPolicy('own_entries', { for: 'all', using: sql`${t.userId} = ${currentUser}`, withCheck: sql`${t.userId} = ${currentUser}` }),
	],
)

/**
 * One card per thing to remember: a key idea from a reading, a lesson from life, or a word. All
 * share one review schedule. `prompt` is the cue, a question that doesn't give the idea away, and
 * `answer` is the idea itself, so every card can be reviewed even with no questions. The card
 * holds its schedule state, so answering is one row update.
 */
export const cards = pgTable(
	'cards',
	{
		id: uuid().primaryKey(),
		userId: uuid()
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		kind: text().$type<'idea' | 'lesson' | 'word'>().notNull(),
		prompt: text().notNull(),
		answer: text().notNull(),
		/** The entry the card came from, such as a lesson entry. */
		entryId: uuid().references(() => entries.id, { onDelete: 'set null' }),
		/** For ideas and words met while reading. */
		readingId: uuid().references((): AnyPgColumn => readings.id, { onDelete: 'cascade' }),
		sectionId: uuid().references((): AnyPgColumn => sections.id, { onDelete: 'cascade' }),
		/** Order of key ideas in a section. */
		position: integer(),
		/** `ai` for key ideas the AI wrote; `member` for saved ideas, lessons and words. */
		origin: text().$type<'ai' | 'member'>().notNull().default('member'),
		/** The exact sentence of the source the idea rests on, shown with the answer. */
		quote: text(),
		/** For words: the word, the form met, its sentence and meaning. */
		details: jsonb().$type<Record<string, unknown>>(),
		/** Index into QUESTION_LEVELS: how hard the next question on this card should be. */
		level: smallint().notNull().default(0),
		/** Null until the card is first recalled. Only started cards are in the review queue. */
		startedAt: timestamp({ withTimezone: true }),
		/** Set when its reading or lesson is removed, cleared on restore. */
		deletedAt: timestamp({ withTimezone: true }),
		state: jsonb().$type<ReviewState>().notNull(),
		dueAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
		createdAt: createdAt(),
	},
	(t) => [index().on(t.userId, t.dueAt), index().on(t.sectionId, t.position), ownRows(t.userId)],
)

/**
 * A question on one card. A card has several, at rising levels; each review asks one. Retired
 * questions are never asked again, and old answers keep pointing at them.
 */
export const questions = pgTable(
	'questions',
	{
		id: id(),
		userId: uuid()
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		cardId: uuid()
			.notNull()
			.references(() => cards.id, { onDelete: 'cascade' }),
		readingId: uuid().references((): AnyPgColumn => readings.id, { onDelete: 'cascade' }),
		sectionId: uuid().references((): AnyPgColumn => sections.id, { onDelete: 'cascade' }),
		/** A key of `questionTypes` in `packages/domain/src/questions.ts`. */
		type: text().notNull(),
		level: text().$type<QuestionLevel>().notNull(),
		/** The type's own content, answer key included; only `toPrompt` of it reaches the client. */
		content: jsonb().$type<Record<string, unknown>>().notNull(),
		promptVersion: text(),
		retiredAt: timestamp({ withTimezone: true }),
		/** Why a member reported it, which also retired it. */
		report: text(),
		createdAt: createdAt(),
	},
	(t) => [index().on(t.cardId), ownRows(t.userId)],
)

/** Every answer, for history and for tuning the schedule later. */
export const reviewLog = pgTable(
	'review_log',
	{
		id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
		userId: uuid()
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		cardId: uuid()
			.notNull()
			.references(() => cards.id, { onDelete: 'cascade' }),
		/** Chosen by the client, so a double tap or a retry counts once. Null on rows from before. */
		answerId: uuid().unique(),
		/** The question asked; null for cue recall and self-rated cards. */
		questionId: uuid().references(() => questions.id, { onDelete: 'set null' }),
		ask: text().$type<'question' | 'cue' | 'self'>().notNull().default('self'),
		/** `recall` right after reading, `review` from the queue, `practice` for a retry round (schedule unchanged). */
		mode: text().$type<'recall' | 'review' | 'practice'>().notNull().default('review'),
		rating: text().$type<Rating>().notNull(),
		correct: boolean(),
		/** What the learner wrote or picked. */
		response: jsonb().$type<Record<string, unknown>>(),
		confidence: text().$type<Confidence>(),
		/** The judge's feedback. */
		feedback: text(),
		/** What the result showed: the model answer, the points made or missed, the quote. */
		reveal: jsonb().$type<Reveal>(),
		gradedBy: text().$type<'code' | 'ai' | 'self'>().notNull().default('self'),
		/** The recall check this answer was part of, so its results can list it. */
		attemptId: uuid().references((): AnyPgColumn => recallAttempts.id, { onDelete: 'set null' }),
		/** Set when the learner tapped Count it as right. */
		overriddenAt: timestamp({ withTimezone: true }),
		/**
		 * The card's schedule and level just before this answer, so Count it as right and Report a
		 * problem can work the schedule out again from here. Null on rows from before.
		 */
		prev: jsonb().$type<{ state: ReviewState; level: number; dueAt: string }>(),
		/** The scheduler's predicted chance of recall at the moment of answering. */
		predictedRecall: real(),
		/** Which scheduler made the decision. */
		scheduler: text().notNull().default('steps-ease-v1'),
		reviewedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
		nextDueAt: timestamp({ withTimezone: true }).notNull(),
	},
	(t) => [index().on(t.cardId), index().on(t.attemptId), ownRows(t.userId)],
)

/** Each member's own AI key, encrypted. */
export const aiKeys = pgTable(
	'ai_keys',
	{
		userId: uuid()
			.primaryKey()
			.references(() => users.id, { onDelete: 'cascade' }),
		provider: text().$type<'anthropic' | 'openai'>().notNull(),
		model: text().notNull(),
		keyCt: text().notNull(),
		last4: text().notNull(),
		updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [ownRows(t.userId)],
)

/**
 * Something to read in the Mind pillar. A link is added as `importing`; the import job fills in
 * its title, author and sections, then sets `ready`, or `failed` with a message for the member.
 */
export const readings = pgTable(
	'readings',
	{
		/** Chosen by the client, so a retried add can't make a duplicate. */
		id: uuid().primaryKey(),
		userId: uuid()
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		title: text().notNull(),
		author: text(),
		/**
		 * `pdf_url` is a link that turned out to be a PDF; `web_book` a link to the contents page of
		 * a book whose chapters are each their own page; `web_capture` a page the extension saved
		 * from the member's own browser.
		 */
		source: text().$type<'url' | 'pdf_url' | 'web_book' | 'web_capture' | 'epub' | 'pdf_upload'>().notNull(),
		/** The link as the member added it, normalised. The same link always finds the same reading. */
		requestedUrl: text(),
		/** The page's canonical address, or where the link ended after redirects. */
		sourceUrl: text(),
		/** SHA-256 of an uploaded file, so the same file added twice is one reading. */
		fileHash: text(),
		publishedAt: timestamp({ withTimezone: true }),
		status: text().$type<'importing' | 'ready' | 'failed'>().notNull().default('importing'),
		/** Why the import failed, written for the member. */
		error: text(),
		wordCount: integer().notNull().default(0),
		/** When the member reached the end of the reading's last section. */
		readAt: timestamp({ withTimezone: true }),
		/** Where the member stopped: the section, and the block at the top of the screen. Continue opens here. */
		position: jsonb().$type<{ sectionId: string; block: number }>(),
		/** When a position was last saved, so the reading the member last had open can be found. */
		lastOpenedAt: timestamp({ withTimezone: true }),
		/**
		 * For a chapter page of a web book: the book it belongs to, which the member can add whole.
		 * `pages` is how many pages its contents list names.
		 */
		partOfBook: jsonb().$type<{ contentsUrl: string; title: string; pages: number }>(),
		/**
		 * Set when this link turned out to be a page the member already has under another link.
		 * The reading is then hidden, and opening it opens the one it points at.
		 */
		mergedInto: uuid().references((): AnyPgColumn => readings.id, { onDelete: 'cascade' }),
		createdAt: createdAt(),
		deletedAt: timestamp({ withTimezone: true }),
	},
	(t) => [
		index().on(t.userId, t.createdAt.desc()),
		uniqueIndex().on(t.userId, t.requestedUrl).where(sql`${t.requestedUrl} is not null`),
		uniqueIndex().on(t.userId, t.fileHash).where(sql`${t.fileHash} is not null`),
		index().on(t.userId, t.sourceUrl),
		index().on(t.userId, t.lastOpenedAt.desc()),
		ownRows(t.userId),
	],
)

/**
 * A book the member makes from articles (issue #5), such as a book on a site behind a login with
 * one page per chapter. Its chapters are readings; the book only holds them in order.
 */
export const books = pgTable(
	'books',
	{
		/** Chosen by the client, so a retried create can't make a duplicate. */
		id: uuid().primaryKey(),
		userId: uuid()
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		title: text().notNull(),
		author: text(),
		createdAt: createdAt(),
		/** Removed books are hidden, their chapters show as articles again, and Undo brings them back. */
		deletedAt: timestamp({ withTimezone: true }),
	},
	(t) => [index().on(t.userId, t.createdAt.desc()), ownRows(t.userId)],
)

/** One reading in a book, at `position` (from 0). A reading is a chapter of one book at most. */
export const bookChapters = pgTable(
	'book_chapters',
	{
		readingId: uuid()
			.primaryKey()
			.references(() => readings.id, { onDelete: 'cascade' }),
		bookId: uuid()
			.notNull()
			.references(() => books.id, { onDelete: 'cascade' }),
		userId: uuid()
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		position: integer().notNull(),
		addedAt: createdAt(),
	},
	(t) => [index().on(t.bookId, t.position), ownRows(t.userId)],
)

/**
 * The file a reading was uploaded as, kept after import so the book can be read again when the
 * parsers improve, and so OCR can use a scan later.
 */
export const readingFiles = pgTable(
	'reading_files',
	{
		readingId: uuid()
			.primaryKey()
			.references(() => readings.id, { onDelete: 'cascade' }),
		userId: uuid()
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		name: text().notNull(),
		contentType: text().notNull(),
		size: integer().notNull(),
		data: bytea().notNull(),
		createdAt: createdAt(),
	},
	(t) => [ownRows(t.userId)],
)

/**
 * The pages of a web book while it is imported, one row per page its contents list names. Each
 * page's blocks, or why it couldn't be added, are kept as they arrive, so an import that stops
 * goes on where it was. The rows are deleted when the book is stored as sections.
 */
export const webBookPages = pgTable(
	'web_book_pages',
	{
		readingId: uuid()
			.notNull()
			.references(() => readings.id, { onDelete: 'cascade' }),
		userId: uuid()
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		position: integer().notNull(),
		url: text().notNull(),
		title: text().notNull(),
		level: smallint().notNull(),
		kind: text().$type<SectionKind>().notNull(),
		blocks: jsonb().$type<Block[]>(),
		/** Why the page couldn't be added, written for the member. */
		error: text(),
	},
	(t) => [primaryKey({ columns: [t.readingId, t.position] }), ownRows(t.userId)],
)

/** An image from a reading, re-encoded as WebP. Kept in Postgres for now, so backups include it. */
export const media = pgTable(
	'media',
	{
		id: id(),
		userId: uuid()
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		readingId: uuid()
			.notNull()
			.references(() => readings.id, { onDelete: 'cascade' }),
		contentType: text().notNull(),
		bytes: integer().notNull(),
		width: integer().notNull(),
		height: integer().notNull(),
		data: bytea().notNull(),
		createdAt: createdAt(),
	},
	(t) => [index().on(t.readingId), ownRows(t.userId)],
)

/** One unit of recall in a reading, in reading order. `level` 1 to 3 nests sections into a tree. */
export const sections = pgTable(
	'sections',
	{
		id: id(),
		userId: uuid()
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		readingId: uuid()
			.notNull()
			.references(() => readings.id, { onDelete: 'cascade' }),
		position: integer().notNull(),
		level: smallint().notNull(),
		title: text().notNull(),
		blocks: jsonb().$type<Block[]>().notNull(),
		wordCount: integer().notNull(),
		/** True when the title is a heading the AI added, not the author's. */
		aiTitle: boolean().notNull().default(false),
		/** `reference` (a bibliography) is kept to read, with no questions and outside progress. */
		kind: text().$type<SectionKind>().notNull().default('body'),
		/** Which chapter of a book the section came from, counting from 0; 0 for an article. */
		chapter: integer().notNull().default(0),
		/**
		 * True for every section of a long chapter with no headings that is cut by length alone,
		 * until the AI adds its headings when the member opens it.
		 */
		headingsPending: boolean().notNull().default(false),
		/** The footnotes and endnotes this section's note markers open. */
		notes: jsonb().$type<Note[]>().notNull().default([]),
		/** For a web book, the page the section came from; null when it is the reading's own page or file. */
		sourceUrl: text(),
		/** The first time the member spent 30 active seconds in this section (`readings.seen`). */
		firstSeenAt: timestamp({ withTimezone: true }),
		/** The first time the end of this section was on the member's screen. */
		readAt: timestamp({ withTimezone: true }),
		/**
		 * Where writing its key ideas and questions stands. `needs_key`: the member has no AI key;
		 * `paused`: this month's AI budget is used.
		 */
		writeStatus: text().$type<WriteStatus>().notNull().default('none'),
		/** Why writing failed, written for the member. */
		writeError: text(),
		/** The prompt version that wrote its key ideas. */
		promptVersion: text(),
		/** The first time the member finished a recall check on this section. */
		recalledAt: timestamp({ withTimezone: true }),
		/** Key ideas past the most a section keeps, which the member can add from the recall results. */
		spareIdeas: jsonb().$type<{ idea: string; cue: string; quote: string }[]>().notNull().default([]),
		createdAt: createdAt(),
	},
	(t) => [uniqueIndex().on(t.readingId, t.position), index().on(t.readingId, t.chapter), ownRows(t.userId)],
)

/** Active seconds the member spent in a reading on one day (UTC), added to by the reader's heartbeat. */
export const readingTime = pgTable(
	'reading_time',
	{
		userId: uuid()
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		readingId: uuid()
			.notNull()
			.references(() => readings.id, { onDelete: 'cascade' }),
		day: date().notNull(),
		seconds: integer().notNull(),
	},
	(t) => [primaryKey({ columns: [t.userId, t.readingId, t.day] }), ownRows(t.userId)],
)

/** One row per call to a member's AI provider: what it was for and the tokens it used. */
export const aiCalls = pgTable(
	'ai_calls',
	{
		id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
		userId: uuid()
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		purpose: text().notNull(),
		model: text().notNull(),
		inputTokens: integer(),
		outputTokens: integer(),
		ok: boolean().notNull(),
		error: text(),
		ms: integer().notNull(),
		at: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [index().on(t.userId, t.at), ownRows(t.userId)],
)

/**
 * One row per member: how the app should work for them. The row is written with the column
 * defaults the first time it is read. Kept off `users`, which has no row-level security by design.
 */
export const preferences = pgTable(
	'preferences',
	{
		userId: uuid()
			.primaryKey()
			.references(() => users.id, { onDelete: 'cascade' }),
		timezone: text().notNull().default('UTC'),
		questionAmount: text().$type<'quick' | 'standard' | 'thorough'>().notNull().default('standard'),
		questionStyle: text().$type<'mixed' | 'written' | 'choice'>().notNull().default('mixed'),
		qualityCheck: boolean().notNull().default(true),
		guessFirst: boolean().notNull().default(true),
		desiredRetention: real().notNull().default(0.9),
		/** Background AI work pauses once this month's estimated spend reaches it. */
		aiMonthlyBudgetUsd: numeric({ precision: 8, scale: 2, mode: 'number' }).notNull().default(5),
		reviewBatch: integer().notNull().default(20),
		updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [ownRows(t.userId)],
)

/** One thing a recall check asks: a stored question on the card, or its cue when `questionId` is null. */
export type RecallItem = { cardId: string; questionId: string | null }

/**
 * One recall check: the member's brain dump after reading one or more sections, and how it
 * covered their key ideas. The dump can be personal, so it is stored encrypted.
 */
export const recallAttempts = pgTable(
	'recall_attempts',
	{
		/** Chosen by the client, so a retried start can't make a second attempt. */
		id: uuid().primaryKey(),
		userId: uuid()
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		readingId: uuid()
			.notNull()
			.references(() => readings.id, { onDelete: 'cascade' }),
		sectionIds: uuid().array().notNull(),
		/** The dump, encrypted; null until it is submitted. An empty dump is "Nothing comes to mind". */
		textCt: text(),
		source: text().$type<'typed' | 'voice'>().notNull().default('typed'),
		/**
		 * `open` until the dump is submitted; `waiting` while the key ideas are still written;
		 * `grading`; then `graded`, or `self` when the member has no AI key, or `failed`.
		 */
		status: text().$type<RecallStatus>().notNull().default('open'),
		/** One mark per key idea, once graded. */
		results: jsonb().$type<{ cardId: string; status: PointStatus }[]>(),
		/** What to ask after the dump, in order: one item per key idea, a question or its cue. */
		items: jsonb().$type<RecallItem[]>(),
		feedback: text(),
		gradedBy: text().$type<'code' | 'ai' | 'self'>(),
		submittedAt: timestamp({ withTimezone: true }),
		createdAt: createdAt(),
	},
	(t) => [index().on(t.userId, t.createdAt.desc()), ownRows(t.userId)],
)
