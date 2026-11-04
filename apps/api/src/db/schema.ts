import type { Block, ContentSourceType, IdeaSchedule, PointStatus, QuestionIntensity, QuestionLevel, QuestionStyle, QuestionType, Rating } from '@peak/core'
import type { ProviderId } from '@peak/llm'
import { sql } from 'drizzle-orm'
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

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
	/** A second AI call checks new questions, and their answer keys, before they are stored. */
	qualityCheck: boolean('quality_check').notNull().default(true),
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

/** A bucket of readings kept in order, such as the pages captured from one website. */
export const collections = pgTable(
	'collections',
	{
		id: id(),
		userId: userRef(),
		name: text('name').notNull(),
		createdAt: createdAt(),
	},
	(t) => [index('collections_user_idx').on(t.userId, t.createdAt)],
)

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
		/**
		 * Long readings (books) get questions chapter by chapter, when the user picks a chapter to be
		 * tested on, instead of all at once.
		 */
		questionsOnDemand: boolean('questions_on_demand').notNull().default(false),
		/** The bucket this reading is in, and its place there; both null when it is in none. */
		collectionId: uuid('collection_id').references(() => collections.id, { onDelete: 'set null' }),
		collectionPosition: integer('collection_position'),
		createdAt: createdAt(),
	},
	(t) => [index('items_user_idx').on(t.userId, t.createdAt), index('items_collection_idx').on(t.collectionId, t.collectionPosition)],
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
		/** For readings with questions on demand: the user asked for this section's questions. */
		questionsWanted: boolean('questions_wanted').notNull().default(false),
	},
	(t) => [index('sections_item_idx').on(t.itemId, t.position)],
)

/**
 * A section's key ideas: what the learner should recall without the text. The brain dump is
 * graded against them, and questions point at the idea they test.
 */
export const ideas = pgTable(
	'ideas',
	{
		id: id(),
		itemId: uuid('item_id')
			.notNull()
			.references(() => contentItems.id, { onDelete: 'cascade' }),
		sectionId: uuid('section_id')
			.notNull()
			.references(() => sections.id, { onDelete: 'cascade' }),
		position: integer('position').notNull(),
		text: text('text').notNull(),
	},
	(t) => [index('ideas_section_idx').on(t.sectionId, t.position)],
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
		/** The key idea this question tests; null for questions written before ideas existed. */
		ideaId: uuid('idea_id').references(() => ideas.id, { onDelete: 'set null' }),
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

/** A brain dump at the start of a test: what the user wrote and which key ideas it covered. */
export const recallAttempts = pgTable(
	'recall_attempts',
	{
		id: id(),
		userId: userRef(),
		itemId: uuid('item_id')
			.notNull()
			.references(() => contentItems.id, { onDelete: 'cascade' }),
		sectionIds: uuid('section_ids').array().notNull(),
		text: text('text').notNull(),
		/** One entry per key idea of the picked sections; null until graded. */
		results: jsonb('results').$type<{ ideaId: string; status: PointStatus }[]>(),
		feedback: text('feedback'),
		createdAt: createdAt(),
	},
	(t) => [index('recall_attempts_user_idx').on(t.userId, t.createdAt)],
)

/** One row per idea the user has answered a question on: its review schedule. */
export const ideaReviews = pgTable(
	'idea_reviews',
	{
		ideaId: uuid('idea_id')
			.primaryKey()
			.references(() => ideas.id, { onDelete: 'cascade' }),
		userId: userRef(),
		schedule: jsonb('schedule').$type<IdeaSchedule>().notNull(),
		/** Copied from the schedule so learned ideas can be counted in SQL. */
		mastered: boolean('mastered').notNull().default(false),
		dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
		lastReviewedAt: timestamp('last_reviewed_at', { withTimezone: true }).notNull(),
		/** The question asked last, so the next review asks a different one. */
		lastQuestionId: uuid('last_question_id').references(() => questions.id, { onDelete: 'set null' }),
	},
	(t) => [index('idea_reviews_due_idx').on(t.userId, t.dueAt)],
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
		/** A retry-round answer: logged, but it does not move the idea's schedule. */
		practice: boolean('practice').notNull().default(false),
		/** The judge's feedback, kept for a future error journal. */
		feedback: text('feedback'),
		reviewedAt: timestamp('reviewed_at', { withTimezone: true }).notNull().default(sql`now()`),
	},
	(t) => [index('review_log_user_idx').on(t.userId, t.reviewedAt)],
)

/** An image we downloaded and re-encoded; its bytes live in the MediaStore under its id. */
export const media = pgTable(
	'media',
	{
		id: id(),
		userId: userRef(),
		contentType: text('content_type').notNull(),
		bytes: integer('bytes').notNull(),
		width: integer('width').notNull(),
		height: integer('height').notNull(),
		createdAt: createdAt(),
	},
	(t) => [index('media_user_idx').on(t.userId)],
)
