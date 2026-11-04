import type { Block, ContentSourceType, QuestionIntensity, QuestionLevel, QuestionStyle, QuestionType, Rating, ReviewState } from '@peak/core'
import type { ProviderId } from '@peak/llm'
import { sql } from 'drizzle-orm'
import { boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core'

const id = () => uuid('id').primaryKey().defaultRandom()
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
const userRef = () =>
	uuid('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' })

export const users = pgTable('users', {
	id: id(),
	email: text('email').notNull().unique(),
	timezone: text('timezone').notNull().default('UTC'),
	reminderTime: text('reminder_time'), // "HH:MM" local time, null when reminders are off
	dailyReviewCap: integer('daily_review_cap').notNull().default(80),
	createdAt: createdAt(),
})

export const otpCodes = pgTable(
	'otp_codes',
	{
		id: id(),
		email: text('email').notNull(),
		codeHash: text('code_hash').notNull(),
		attempts: integer('attempts').notNull().default(0),
		expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
		consumedAt: timestamp('consumed_at', { withTimezone: true }),
		createdAt: createdAt(),
	},
	(t) => [index('otp_email_idx').on(t.email, t.createdAt)],
)

export const sessions = pgTable('sessions', {
	id: id(),
	userId: userRef(),
	tokenHash: text('token_hash').notNull().unique(),
	expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
	createdAt: createdAt(),
})

export const llmKeys = pgTable('llm_keys', {
	userId: userRef().primaryKey(),
	provider: text('provider').$type<ProviderId>().notNull(),
	model: text('model').notNull(),
	/** Envelope-encrypted key; see crypto.ts. Never returned to clients. */
	encryptedKey: text('encrypted_key').notNull(),
	last4: text('last4').notNull(),
	createdAt: createdAt(),
})

export type ItemStatus = 'processing' | 'ready' | 'needs_key' | 'failed'

export const contentItems = pgTable(
	'content_items',
	{
		id: id(),
		userId: userRef(),
		source: text('source').$type<ContentSourceType>().notNull(),
		title: text('title').notNull(),
		sourceUrl: text('source_url'),
		status: text('status').$type<ItemStatus>().notNull().default('processing'),
		error: text('error'),
		/** What the user asked for when adding it: how many questions, and which kinds. */
		questionIntensity: text('question_intensity').$type<QuestionIntensity>().notNull().default('standard'),
		questionStyle: text('question_style').$type<QuestionStyle>().notNull().default('mixed'),
		lastOpenedAt: timestamp('last_opened_at', { withTimezone: true }),
		createdAt: createdAt(),
	},
	(t) => [index('items_user_idx').on(t.userId, t.createdAt)],
)

export const sections = pgTable(
	'sections',
	{
		id: id(),
		itemId: uuid('item_id')
			.notNull()
			.references(() => contentItems.id, { onDelete: 'cascade' }),
		position: integer('position').notNull(),
		/** 1 for a top-level section, 2 or 3 for nested ones; parents come right before their children. */
		level: integer('level').notNull().default(1),
		title: text('title').notNull(),
		blocks: jsonb('blocks').$type<Block[]>().notNull(),
		wordCount: integer('word_count').notNull(),
		/** The section's key ideas, written with its questions; linking questions are written from these. */
		keyIdeas: jsonb('key_ideas').$type<string[]>().notNull().default([]),
	},
	(t) => [index('sections_item_idx').on(t.itemId, t.position)],
)

export const questions = pgTable(
	'questions',
	{
		id: id(),
		userId: userRef(),
		itemId: uuid('item_id')
			.notNull()
			.references(() => contentItems.id, { onDelete: 'cascade' }),
		sectionId: uuid('section_id')
			.notNull()
			.references(() => sections.id, { onDelete: 'cascade' }),
		type: text('type').$type<QuestionType>().notNull(),
		/** Null for questions written before levels existed. */
		level: text('level').$type<QuestionLevel>(),
		/**
		 * Set for linking questions: the other sections they draw on. The question belongs to its last
		 * section and is asked only when every one of these is picked too.
		 */
		alsoSectionIds: uuid('also_section_ids').array(),
		content: jsonb('content').notNull(),
		promptVersion: text('prompt_version').notNull(),
		createdAt: createdAt(),
	},
	(t) => [index('questions_section_idx').on(t.sectionId)],
)

/** A timed reading session (a pomodoro). Cancelled sessions are deleted, so every row is focus time. */
export const studySessions = pgTable(
	'study_sessions',
	{
		id: id(),
		userId: userRef(),
		itemId: uuid('item_id')
			.notNull()
			.references(() => contentItems.id, { onDelete: 'cascade' }),
		plannedMinutes: integer('planned_minutes').notNull(),
		startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
		/** Null while the session is running. */
		endedAt: timestamp('ended_at', { withTimezone: true }),
	},
	(t) => [index('study_sessions_user_idx').on(t.userId, t.startedAt)],
)

/** One row per question the user has answered at least once: its review schedule. */
export const reviews = pgTable(
	'reviews',
	{
		questionId: uuid('question_id')
			.notNull()
			.references(() => questions.id, { onDelete: 'cascade' }),
		userId: userRef(),
		state: jsonb('state').$type<ReviewState>().notNull(),
		dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
		lastReviewedAt: timestamp('last_reviewed_at', { withTimezone: true }).notNull(),
	},
	(t) => [primaryKey({ columns: [t.questionId] }), index('reviews_due_idx').on(t.userId, t.dueAt)],
)

export const reviewLog = pgTable(
	'review_log',
	{
		id: id(),
		userId: userRef(),
		questionId: uuid('question_id')
			.notNull()
			.references(() => questions.id, { onDelete: 'cascade' }),
		rating: text('rating').$type<Rating>().notNull(),
		correct: boolean('correct').notNull(),
		response: jsonb('response'),
		/** The judge's feedback, kept for a future error journal. */
		feedback: text('feedback'),
		reviewedAt: timestamp('reviewed_at', { withTimezone: true }).notNull().default(sql`now()`),
	},
	(t) => [index('review_log_user_idx').on(t.userId, t.reviewedAt)],
)
