import type { Block, ReviewState } from '@life-log-club/domain'
import { type AnyColumn, sql } from 'drizzle-orm'
import {
	type AnyPgColumn,
	bigint,
	boolean,
	index,
	integer,
	jsonb,
	pgPolicy,
	pgTable,
	smallint,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from 'drizzle-orm/pg-core'

const id = () => uuid().primaryKey().defaultRandom()
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
 * One card per thing to remember: an idea from reading or a lesson from life. Both share one
 * review schedule. The card holds its schedule state, so answering is one row update.
 */
export const cards = pgTable(
	'cards',
	{
		id: uuid().primaryKey(),
		userId: uuid()
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		kind: text().$type<'idea' | 'lesson'>().notNull(),
		prompt: text().notNull(),
		answer: text().notNull(),
		/** The entry the card came from, such as a lesson entry. */
		entryId: uuid().references(() => entries.id, { onDelete: 'set null' }),
		state: jsonb().$type<ReviewState>().notNull(),
		dueAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
		createdAt: createdAt(),
	},
	(t) => [index().on(t.userId, t.dueAt), ownRows(t.userId)],
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
		rating: text().$type<'again' | 'hard' | 'good' | 'easy'>().notNull(),
		reviewedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
		nextDueAt: timestamp({ withTimezone: true }).notNull(),
	},
	(t) => [index().on(t.cardId), ownRows(t.userId)],
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
		source: text().$type<'url'>().notNull(),
		/** The link as the member added it, normalised. The same link always finds the same reading. */
		requestedUrl: text(),
		/** The page's canonical address, or where the link ended after redirects. */
		sourceUrl: text(),
		publishedAt: timestamp({ withTimezone: true }),
		status: text().$type<'importing' | 'ready' | 'failed'>().notNull().default('importing'),
		/** Why the import failed, written for the member. */
		error: text(),
		wordCount: integer().notNull().default(0),
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
		index().on(t.userId, t.sourceUrl),
		ownRows(t.userId),
	],
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
		createdAt: createdAt(),
	},
	(t) => [uniqueIndex().on(t.readingId, t.position), ownRows(t.userId)],
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
