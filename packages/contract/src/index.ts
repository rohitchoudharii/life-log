import {
	Block,
	CONFIDENCES,
	EntryData,
	EntryText,
	EXPLAIN_KINDS,
	GAP_BUCKETS,
	MAX_TEACH_CHARS,
	MAX_WORD_CHARS,
	WORD_TESTS,
	Note,
	PILLARS,
	QUESTION_AMOUNTS,
	QUESTION_STYLES,
	RECALL_STATUSES,
	WRITE_STATUSES,
} from '@life-log-club/domain'
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
	/** For ideas from a reading: where they came from, and the passage they rest on. */
	readingId: z.uuid().nullable(),
	sectionId: z.uuid().nullable(),
	quote: z.string().nullable(),
	dueAt: z.date(),
})
export type Card = z.infer<typeof Card>

/** The longest passage a saved idea can quote. */
export const MAX_QUOTE_CHARS = 1000

/**
 * A word in the member's vocabulary. `meaning` is null until there is one; `defining` says the
 * AI is writing it now.
 */
export const Word = z.object({
	id: z.uuid(),
	word: z.string(),
	/** The word as it appears in its sentence. */
	form: z.string(),
	sentence: z.string().nullable(),
	meaning: z.string().nullable(),
	defining: z.boolean(),
	/** The test the word gets next in Review. */
	test: z.enum(WORD_TESTS),
	readingId: z.uuid().nullable(),
	sectionId: z.uuid().nullable(),
	readingTitle: z.string().nullable(),
	dueAt: z.date(),
	createdAt: z.date(),
})
export type Word = z.infer<typeof Word>

/** A word the AI found worth learning in a section, offered in the reader to keep. */
export const Suggestion = z.object({ word: z.string(), form: z.string(), sentence: z.string(), meaning: z.string() })
export type Suggestion = z.infer<typeof Suggestion>

const SkillWeek = z.object({ minutes: z.int(), sessions: z.int() })

/** A skill the member practises, with this week's practice. Weeks start on Monday (UTC). */
export const Skill = z.object({
	id: z.uuid(),
	name: z.string(),
	goal: z.string().nullable(),
	/** Minutes a week the member aims for; null shows sessions only. */
	weeklyMinutes: z.int().nullable(),
	archived: z.boolean(),
	week: SkillWeek,
	/** Every session so far. */
	sessions: z.int(),
	/** The last session, which the next one starts from: its minutes, and its Next time as the next focus. */
	last: z.object({ at: z.date(), minutes: z.int(), nextTime: z.string().nullable() }).nullable(),
	createdAt: z.date(),
})
export type Skill = z.infer<typeof Skill>

/** One skill in full: the last 8 weeks against the target, and the trail of sessions. */
export const SkillDetail = Skill.extend({
	/** Oldest first, this week last. */
	weeks: z.array(SkillWeek.extend({ week: z.date() })),
	/** Newest first: what each session worked on, what told how it went, the fix for next time, and what was learned. */
	trail: z.array(
		z.object({
			entryId: z.uuid(),
			at: z.date(),
			minutes: z.int(),
			workedOn: z.string().nullable(),
			feedback: z.string().nullable(),
			nextTime: z.string().nullable(),
			learned: z.string().nullable(),
		}),
	),
})
export type SkillDetail = z.infer<typeof SkillDetail>

const SkillName = z.string().trim().min(1, 'Name the skill.').max(80, 'Keep the name short.')
const SkillGoal = z.string().trim().max(200, 'Keep the goal to one line.')
const WeeklyMinutes = z.int().min(1, 'Aim for at least a minute a week.').max(3000, 'That is more than 50 hours a week.')

/**
 * A teach-back: the learner explains an idea to an AI student, who asks up to 3 follow-ups and
 * then sums up. `topic` is the card's cue, what the learner teaches. `result` comes with the
 * summing up, and only then the idea and its quote, to compare. `dueAt` is set when gaps brought
 * the card back sooner.
 */
export const TeachSession = z.object({
	id: z.uuid(),
	cardId: z.uuid(),
	topic: z.string(),
	messages: z.array(z.object({ role: z.enum(['learner', 'student']), text: z.string() })),
	result: z
		.object({
			gaps: z.array(z.string()),
			strengths: z.array(z.string()),
			summary: z.string(),
			idea: z.string(),
			quote: z.string().nullable(),
			dueAt: z.date().nullable(),
		})
		.nullable(),
})
export type TeachSession = z.infer<typeof TeachSession>

/** The longest passage Explain takes: a few paragraphs. */
export const MAX_EXPLAIN_CHARS = 4000

/**
 * A card on the Ideas page: with the titles of the reading and section it came from, and the
 * block of the section its quote starts in, to open the reader there.
 */
export const SavedCard = Card.extend({
	readingTitle: z.string().nullable(),
	sectionTitle: z.string().nullable(),
	block: z.int().nullable(),
	createdAt: z.date(),
})
export type SavedCard = z.infer<typeof SavedCard>

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
	/** The chance of recall to aim for when an idea comes back, from 0.8 to 0.95. Higher means more reviews. */
	desiredRetention: z.number().min(0.8, 'Choose a target of 80% or more.').max(0.95, 'Choose a target of 95% or less.'),
	/** Guess first: type a few words before multiple-choice options show. On by default. */
	guessFirst: z.boolean(),
	/** How many questions each key idea gets: Quick none (its cue only), Standard one, Thorough two. */
	questionAmount: z.enum(QUESTION_AMOUNTS),
	/** Which kinds: Mixed (mostly written, some multiple choice), Written or Choice. */
	questionStyle: z.enum(QUESTION_STYLES),
	/** Check questions twice: a second AI call checks each question before it is kept. */
	qualityCheck: z.boolean(),
})
export type Preferences = z.infer<typeof Preferences>

const Rating = z.enum(['again', 'hard', 'good', 'easy'])
const Confidence = z.enum(CONFIDENCES)
/** A written answer, or I don't know. */
const Written = z.union([
	z.object({
		answer: z.string().trim().min(1, 'Write an answer, or choose I don’t know.').max(4000),
		/** Without an AI key: which of the checklist's points the learner made, in order. */
		made: z.array(z.boolean()).max(6).optional(),
	}),
	z.object({ skipped: z.literal(true) }),
])
const answerOf = {
	answerId: z.uuid(),
	cardId: z.uuid(),
	mode: z.enum(['recall', 'review', 'practice']),
	/** The recall check the answer is part of. */
	attemptId: z.uuid().optional(),
}
/** One answer: to a stored question, to the card's cue (written recall), to a word's test, or a self-rating. */
export const Answer = z.discriminatedUnion('ask', [
	z.object({ ...answerOf, ask: z.literal('question'), questionId: z.uuid(), response: z.record(z.string(), z.unknown()), confidence: Confidence.nullable().default(null) }),
	z.object({ ...answerOf, ask: z.literal('cue'), response: Written, confidence: Confidence.nullable().default(null) }),
	/** A word's test at its level: fill the blank, say what it means, or use it. */
	z.object({ ...answerOf, ask: z.literal('word'), response: Written, confidence: Confidence.nullable().default(null) }),
	z.object({ ...answerOf, ask: z.literal('self'), rating: Rating }),
])
export type Answer = z.infer<typeof Answer>

/** What a checked answer showed: the verdict, the model answer, and the points made or missed. */
export const Reveal = z.object({
	/** The model answer, or the idea itself for a cue. */
	reference: z.string().nullable(),
	/** The judge's feedback, 1 to 3 sentences. */
	feedback: z.string(),
	/** The points a complete answer makes, each with how this answer made it. */
	points: z.array(z.object({ point: z.string(), status: z.enum(['covered', 'vague', 'missing']) })),
	misconception: z.string().nullable(),
	/** The quote from the text the idea rests on. */
	quote: z.string().nullable(),
	/**
	 * For a multiple-choice question: every option, the right one, the learner's pick (null for
	 * I don't know), and why each wrong option is wrong.
	 */
	choice: z
		.object({
			options: z.array(z.string()),
			right: z.int(),
			picked: z.int().nullable(),
			whyWrong: z.array(z.string()),
			/** The guess typed before the options showed, with Guess first; absent on answers from before it. */
			guess: z.string().nullable().optional(),
		})
		.optional(),
	/** For a worked problem or predicted output: the right answer and the learner's, as typed. */
	exact: z.object({ kind: z.enum(['number', 'output', 'word']), expected: z.string(), given: z.string().nullable() }).optional(),
	/** For a word's test: the word, and which test it was. `reference` is its meaning. */
	word: z.object({ word: z.string(), test: z.enum(WORD_TESTS) }).optional(),
	/** For an order question: the steps in the right order, the learner's order as indexes into them, and the share of pairs in order. */
	order: z.object({ steps: z.array(z.string()), given: z.array(z.number()).nullable(), pairs: z.number() }).optional(),
})
export type Reveal = z.infer<typeof Reveal>
export const AnswerResult = z.object({
	correct: z.boolean(),
	rating: Rating,
	reveal: Reveal,
	/** When the card comes back; for a practice answer, when it was due already. */
	dueAt: z.date(),
	/** The learner tapped Count it as right on it. */
	overridden: z.boolean(),
})
export type AnswerResult = z.infer<typeof AnswerResult>

/** One thing to ask: a stored question on a card, or the card's cue when `questionId` is null. */
export const AskItem = z.object({
	cardId: z.uuid(),
	questionId: z.uuid().nullable(),
	prompt: z.string(),
	/** Code the question is about, shown as code. */
	code: z.string().nullable(),
	/** A multiple-choice question's options, or an order question's steps, in the order shown; null for a written one. */
	options: z.array(z.string()).nullable(),
	/** The question's type, which says how it is answered; null for a cue, which is written. */
	type: z.string().nullable(),
	/** A worked problem's unit, shown by the answer box; null otherwise. */
	unit: z.string().nullable(),
	answered: z.boolean(),
})
export type AskItem = z.infer<typeof AskItem>

/** A recall check: the brain dump after reading, and how it covered each key idea. */
export const RecallAttempt = z.object({
	id: z.uuid(),
	readingId: z.uuid(),
	readingTitle: z.string(),
	sections: z.array(z.object({ id: z.uuid(), title: z.string() })),
	/**
	 * `open` until the dump is sent; `waiting` while the key ideas are written; `grading`; then
	 * `graded`, `self` when there is no AI key to check it, or `failed`.
	 */
	status: z.enum(RECALL_STATUSES),
	/** The dump as written; empty for Nothing comes to mind, null before it is sent. */
	text: z.string().nullable(),
	feedback: z.string().nullable(),
	/**
	 * The questions after the dump, once it is graded: one per key idea, missed ideas first. The
	 * results come only after the last one is answered.
	 */
	items: z.array(AskItem).nullable(),
	/**
	 * The results, once every question is answered: every key idea with its dump mark, its answer
	 * and when it comes back.
	 */
	ideas: z
		.array(
			z.object({
				cardId: z.uuid(),
				idea: z.string(),
				quote: z.string().nullable(),
				status: z.enum(['covered', 'vague', 'missing']),
				dueAt: z.date(),
				answer: z
					.object({
						answerId: z.uuid(),
						prompt: z.string(),
						/** What the learner wrote; null for I don't know. */
						given: z.string().nullable(),
						correct: z.boolean(),
						confidence: Confidence.nullable(),
						overridden: z.boolean(),
						reveal: Reveal,
					})
					.nullable(),
			}),
		)
		.nullable(),
	/** Retry missed ideas: a new question, or the cue, for each idea answered wrong. Practice only. */
	retry: z.array(AskItem).nullable(),
	/** The section after the last one recalled, where Done goes on reading; null at the end. */
	nextSectionId: z.uuid().nullable(),
	/**
	 * The member has no AI key, so they check their answers themselves: each written answer
	 * against the checklist from `review.checklist`.
	 */
	selfCheck: z.boolean(),
	/**
	 * While `self`: the key ideas the member marks against their dump with `recall.selfMark`, in
	 * reading order. Empty when the sections have none; then the dump can only be compared.
	 */
	toMark: z.array(z.object({ cardId: z.uuid(), idea: z.string() })).nullable(),
})
export type RecallAttempt = z.infer<typeof RecallAttempt>

/** How many answers were right out of how many. */
const RightOf = z.object({ right: z.int(), total: z.int() })
const IdeaCounts = z.object({ new: z.int(), learning: z.int(), known: z.int(), fading: z.int() })

/** A graduated idea not due yet, with its predicted chance of recall now (0 to 1). */
export const FadingIdea = z.object({
	cardId: z.uuid(),
	prompt: z.string(),
	source: z.object({ reading: z.string(), section: z.string().nullable() }).nullable(),
	recall: z.number(),
})
export type FadingIdea = z.infer<typeof FadingIdea>

/** What Mind and the Home card show beyond the due count. */
export const MindSummary = z.object({
	/** Up to 3 graduated ideas not due yet, lowest predicted recall first. */
	fading: z.array(FadingIdea),
	/** Recall at review over the last 30 days (see `ProgressSummary.recallAtReview`); shown from 20 reviews. */
	recall30d: RightOf,
})
export type MindSummary = z.infer<typeof MindSummary>

/**
 * The Progress page. Recall at review counts the first answer of the day to each card already
 * past the 1, 2 and 3 day steps, in Review, leaving out answers counted as right by the member
 * and reported ones.
 */
export const ProgressSummary = z.object({
	/** Every card by status now, in total and for each reading with cards. */
	ideas: z.object({
		total: IdeaCounts,
		readings: z.array(z.object({ readingId: z.uuid(), title: z.string(), counts: IdeaCounts })),
	}),
	recallAtReview: RightOf.extend({
		/** The member's target, to draw as a line. */
		target: z.number(),
		/** By week, oldest first; each week starts on Monday (UTC). */
		weeks: z.array(RightOf.extend({ week: z.date() })),
	}),
	/** Review answers by the days since the card's previous answer, the steps included. */
	recallByGap: z.array(RightOf.extend({ gap: z.enum(GAP_BUCKETS) })),
	/** Each graded brain dump, oldest first: how many of its key ideas it covered. */
	dumps: z.array(z.object({ attemptId: z.uuid(), at: z.date(), reading: z.string(), covered: z.int(), total: z.int() })),
	/**
	 * How often each confidence was right, over recall and review answers given with one, and how
	 * many answers this calendar month (UTC) were wrong though the member was sure.
	 */
	calibration: z.object({ sure: RightOf, think_so: RightOf, guessing: RightOf, sureWrongThisMonth: z.int() }),
	/** Practice minutes per skill by week (Monday, UTC), every week of the period, oldest first; skills with practice in it only. */
	practice: z.array(z.object({ skillId: z.uuid(), name: z.string(), weeklyMinutes: z.int().nullable(), weeks: z.array(z.object({ week: z.date(), minutes: z.int() })) })),
})
export type ProgressSummary = z.infer<typeof ProgressSummary>

export const ReviewFilter = z.enum(['all', 'readings', 'lessons', 'words'])
export type ReviewFilter = z.infer<typeof ReviewFilter>

/** One due card in Review, with the one thing to ask about it. */
export const ReviewItem = z.object({
	cardId: z.uuid(),
	kind: z.enum(['idea', 'lesson', 'word']),
	/** Where the idea comes from, for the small source line; null for a lesson or an idea added by hand. */
	source: z.object({ reading: z.string(), section: z.string().nullable() }).nullable(),
	createdAt: z.date(),
	/** The idea itself, shown after Show answer on a self-rated card, or when the judge fails. */
	answer: z.string(),
	/** The card's cue, which Retry missed ideas asks. */
	cue: z.string(),
	/**
	 * A stored question; the cue, judged against the idea when the member has an AI key; or a
	 * self-rated card without one.
	 */
	ask: z.discriminatedUnion('kind', [
		z.object({
			kind: z.literal('question'),
			questionId: z.uuid(),
			type: z.string(),
			prompt: z.string(),
			code: z.string().nullable(),
			/** A multiple-choice question's options, or an order question's steps, in the order shown; null for a written one. */
			options: z.array(z.string()).nullable(),
			/** A worked problem's unit, shown by the answer box; null otherwise. */
			unit: z.string().nullable(),
		}),
		z.object({ kind: z.literal('cue'), prompt: z.string() }),
		/** A word's test at its level, with its sentence (blanked for the cloze) and, for the cloze, a hint. */
		z.object({ kind: z.literal('word'), test: z.enum(WORD_TESTS), prompt: z.string(), sentence: z.string().nullable(), hint: z.string().nullable() }),
		z.object({ kind: z.literal('self'), prompt: z.string() }),
	]),
})
export type ReviewItem = z.infer<typeof ReviewItem>

/** About 80,000 words: a long report, not a book. Books come as files. */
export const MAX_PASTE_CHARS = 500_000

/** Why a member reports a question. */
export const REPORT_REASONS = ['wrong_answer', 'unclear', 'not_in_text'] as const

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
	source: z.enum(['url', 'pdf_url', 'web_book', 'web_capture', 'epub', 'pdf_upload', 'paste', 'sample']),
	/** When the member reached the end of its last section. */
	readAt: z.date().nullable(),
	/** Where the member stopped reading, which opening the reading goes back to; null before they open it. */
	position: ReadingPosition.nullable(),
	/** The member's book this reading is a chapter of. */
	book: z.object({ id: z.uuid(), title: z.string() }).nullable(),
	/** Words in the sections read to their end, for the share read against a goal. */
	wordsRead: z.int(),
	/** The day the member means to finish it by (YYYY-MM-DD), or null. */
	goalBy: z.string().nullable(),
	/** When the member marked it finished, or null. */
	finishedAt: z.date().nullable(),
	createdAt: z.date(),
})
export type Reading = z.infer<typeof Reading>

/** What finishing a reading kept: time read, ideas held, and recall at their last reviews. */
export const Milestone = z.object({
	seconds: z.int(),
	ideas: z.int(),
	recall: z.object({ right: z.int(), total: z.int() }),
	/** The key lessons saved with it, each now a lesson card. */
	lessons: z.array(z.object({ id: z.uuid(), text: z.string() })),
})
export type Milestone = z.infer<typeof Milestone>

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
			/** The chapter of a book the section is in, counting from 0; 0 for every section of an article. */
			chapter: z.int(),
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
	/**
	 * Whether any of those key ideas has been answered or is in review. Only a section where none
	 * has can have its key ideas written again.
	 */
	ideasInUse: z.boolean(),
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
		 * same id twice returns the first entry. A lesson also gets its review card, due at once,
		 * unless `remember` is false.
		 */
		create: oc
			.input(
				EntryData.and(
					z.object({ id: z.uuid(), occurredAt: z.date().optional(), text: EntryText.optional(), remember: z.boolean().optional() }),
				),
			)
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
		/**
		 * Adds an idea or a lesson to spaced review. It is due at once. The client picks the id.
		 *
		 * An idea saved from a reading gives its `quote`, with the `readingId` and `sectionId` it
		 * came from and the `block` of the section the quote starts in. Then the answer is the
		 * member's own words, else the quote; the cue is their question, else one the AI writes
		 * when they have a key, else "From Title, Section: what did you save here?". Saving is a
		 * study event, so the card is first due in 1 day. Saving a quote already saved from the
		 * same reading returns that card instead, so the id that comes back can differ.
		 */
		add: oc
			.input(
				z
					.object({
						id: z.uuid(),
						kind: z.enum(['idea', 'lesson']),
						prompt: z.string().trim().min(1).max(1000).optional(),
						answer: z.string().trim().min(1).max(5000).optional(),
						entryId: z.uuid().optional(),
						readingId: z.uuid().optional(),
						sectionId: z.uuid().optional(),
						block: z.int().min(0).optional(),
						quote: z.string().trim().min(1).max(MAX_QUOTE_CHARS, 'Pick one idea, not a page.').optional(),
					})
					.refine((i) => (i.quote ? i.readingId && i.sectionId && i.kind === 'idea' : i.prompt && i.answer), {
						message: 'Give a question and its answer, or a quote from a reading.',
					}),
			)
			.output(Card),
		/** Edits an idea the member saved: its cue (`prompt`) or its answer. The schedule stays. */
		update: oc
			.input(z.object({ id: z.uuid(), prompt: z.string().trim().min(1).max(1000).optional(), answer: z.string().trim().min(1).max(5000).optional() }))
			.output(Card),
		/** Hides an idea the member saved, and its reviews; `restore` brings it back (undo). */
		remove: oc.input(z.object({ id: z.uuid() })).output(Ok),
		restore: oc.input(z.object({ id: z.uuid() })).output(Card),
		/** The member's cards, newest first, for the Ideas page. Cards of removed readings are left out. */
		list: oc
			.input(z.object({ readingId: z.uuid().optional(), origin: z.enum(['ai', 'member']).optional(), kind: z.enum(['idea', 'lesson', 'word']).optional() }))
			.output(z.array(SavedCard)),
		/**
		 * Cards due now, oldest first, how many are due in total, and about how many minutes
		 * they take (the member's median answer time, times the count).
		 */
		due: oc
			.input(z.object({ limit: z.int().min(1).max(100).default(20) }))
			.output(z.object({ cards: z.array(Card), total: z.int(), minutes: z.int() })),
		/**
		 * The next batch of due cards for Review, lowest predicted recall first, each with what to
		 * ask: a question not asked yet nearest the card's level, else the cue. With `first`, that
		 * card comes first when it is due.
		 */
		next: oc
			.input(z.object({ limit: z.int().min(1).max(50).default(20), filter: ReviewFilter.default('all'), first: z.uuid().optional() }))
			.output(z.object({ items: z.array(ReviewItem), total: z.int(), minutes: z.int() })),
		/**
		 * Review now: makes a started card that is not due yet due now, so it can be answered
		 * early. A card already due keeps its due time.
		 */
		bringForward: oc.input(z.object({ id: z.uuid() })).output(z.object({ dueAt: z.date() })),
		/**
		 * Records one answer and returns its result and when the card comes back. `answerId` is
		 * chosen by the client, so the same answer sent twice counts once. In `review` mode only a
		 * due card can be answered (`CONFLICT` otherwise); `recall` mode answers right after reading,
		 * and starts a card not started yet; `practice` is logged but leaves the schedule as it is.
		 */
		answer: oc.input(Answer).output(AnswerResult),
		/**
		 * Count it as right: once per written answer the judge marked wrong. The answer is rated
		 * `good`, and the card's schedule is worked out again from the log as if it had been.
		 */
		override: oc.input(z.object({ answerId: z.uuid() })).output(AnswerResult),
		/**
		 * What a complete answer to a question (or to the card's cue, when `questionId` is null)
		 * says, for a learner with no AI key to check their own written answer: the model answer
		 * and the points to tick, in the order `made` takes them.
		 */
		checklist: oc
			.input(z.object({ cardId: z.uuid(), questionId: z.uuid().nullable() }))
			.output(z.object({ reference: z.string(), points: z.array(z.string()), quote: z.string().nullable() })),
	},
	questions: {
		/**
		 * Report a problem with a question: it is retired and never asked again. With `answerId`,
		 * that answer to it no longer counts: it becomes practice, and the card's schedule is put
		 * back as it was before it.
		 */
		report: oc.input(z.object({ id: z.uuid(), reason: z.enum(REPORT_REASONS), answerId: z.uuid().optional() })).output(Ok),
		/**
		 * Rewrite questions: retires the section's questions and writes new ones in the background
		 * for the same key ideas, at the member's amount and kinds. Every answer and schedule stays.
		 * With `ideas`, on a section none of whose key ideas is in use yet (`Section.ideasInUse`),
		 * the key ideas are written again too. The section is `queued`, then `writing`, until done.
		 */
		rewrite: oc.input(z.object({ sectionId: z.uuid(), ideas: z.boolean().default(false) })).output(Ok),
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
		 * Adds pasted text or Markdown to read. It is split into sections at once, like an article,
		 * and comes back `ready`. The title is `title`, else the first heading, else the first
		 * words. The client picks the id; a retry returns the same reading.
		 */
		/**
		 * Adds the sample reading, "How to remember what you read", with its key ideas and
		 * questions already written, the first time a member opens Mind. Never again after that,
		 * even once it is removed. `added` says whether it was added now.
		 */
		addSample: oc.output(z.object({ added: z.boolean() })),
		addText: oc
			.input(
				z.object({
					id: z.uuid(),
					text: z.string().trim().min(1, 'Paste some text to read.').max(MAX_PASTE_CHARS, 'That is too much text to paste at once. Paste one part at a time.'),
					title: z.string().trim().max(200).optional(),
				}),
			)
			.output(Reading),
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
		/**
		 * Explains a passage the member selected, grounded in its section, with their own AI key:
		 * from first principles, as an analogy, or as a worked example. `quote` is the sentence
		 * of the section it relies on, only when it is really there. Nothing is stored.
		 */
		explain: oc
			.input(
				z.object({
					sectionId: z.uuid(),
					passage: z.string().trim().min(1, 'Select some text to explain.').max(MAX_EXPLAIN_CHARS, 'Select a shorter passage: a few paragraphs at most.'),
					kind: z.enum(EXPLAIN_KINDS).default('explain'),
				}),
			)
			.output(z.object({ text: z.string(), code: z.string().nullable(), quote: z.string().nullable() })),
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
		/** Sets the day to finish by, or clears it with null. */
		update: oc
			.input(z.object({ id: z.uuid(), goalBy: z.iso.date('Pick a date.').nullable() }))
			.output(Reading),
		/**
		 * Marks the reading finished and logs a `reading.finished` entry (`entryId`, picked by the
		 * client). Each of `lessons` becomes a lesson card linked to the entry, and the entry's text
		 * holds them all. Finishing a finished reading only adds lessons, to its existing entry; the
		 * same lesson id twice adds it once. At most 3 lessons in all.
		 */
		finish: oc
			.input(
				z.object({
					id: z.uuid(),
					entryId: z.uuid(),
					lessons: z
						.array(z.object({ id: z.uuid(), text: z.string().trim().min(1, 'Write the lesson, or leave the line empty.').max(1000) }))
						.max(3)
						.default([]),
				}),
			)
			.output(z.object({ reading: Reading, entry: Entry, milestone: Milestone })),
		/** Undoes Finished: removes its entry and hides its lesson cards. Restoring the entry finishes it again. */
		unfinish: oc.input(EntryId).output(Reading),
		/** The milestone of a finished reading. */
		milestone: oc.input(EntryId).output(Milestone),
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
	recall: {
		/**
		 * Starts a recall check on sections of a reading (Recall this section). Sections whose key
		 * ideas aren't written yet are written now, ahead of other work and past the budget, while the
		 * member writes the dump. The client picks the id, so a retry starts one attempt.
		 */
		start: oc.input(z.object({ id: z.uuid(), readingId: z.uuid(), sectionIds: z.array(z.uuid()).min(1).max(100) })).output(RecallAttempt),
		/**
		 * Sends the brain dump, which is then graded in the background against the sections' key
		 * ideas. An empty dump is "Nothing comes to mind": every idea counts as missed. Sending again
		 * changes nothing.
		 */
		submit: oc
			.input(
				z.object({
					id: z.uuid(),
					text: z.string().trim().max(20_000, 'That’s longer than a brain dump needs.'),
					source: z.enum(['typed', 'voice']).default('typed'),
				}),
			)
			.output(RecallAttempt),
		/** One attempt. Its ideas and their marks come only once it is graded. */
		get: oc.input(EntryId).output(RecallAttempt),
		/** Grades a failed attempt again. */
		retry: oc.input(EntryId).output(RecallAttempt),
		/**
		 * Without an AI key: the member's own marks of each key idea against their dump. Ideas not
		 * marked count as missed. The questions follow, as after AI grading. Marking again changes
		 * nothing.
		 */
		selfMark: oc
			.input(z.object({ id: z.uuid(), marks: z.array(z.object({ cardId: z.uuid(), status: z.enum(['covered', 'vague', 'missing']) })).max(200) }))
			.output(RecallAttempt),
	},
	mind: {
		/** Fading ideas and the 30-day recall, for Mind and the Home card. */
		summary: oc.output(MindSummary),
	},
	progress: {
		/** The Progress page over the last `days` days (the idea counts are always as of now). */
		summary: oc.input(z.object({ days: z.int().min(7).max(365).default(84) })).output(ProgressSummary),
	},
	preferences: {
		get: oc.output(Preferences),
		/** Changes the preferences given and returns them all. */
		update: oc.input(Preferences.partial()).output(Preferences),
		/**
		 * Where tuning the schedule to the member stands: answers in Recall and Review so far, the
		 * number needed, whether their own FSRS parameters are in use, and the last monthly try.
		 * `improvement` is how much better the kept parameters predicted held-out answers (0 to 1).
		 */
		tuning: oc.output(
			z.object({
				reviews: z.int(),
				needed: z.int(),
				tuned: z.boolean(),
				last: z.object({ at: z.date(), kept: z.boolean(), improvement: z.number() }).nullable(),
			}),
		),
	},
	/** The member's vocabulary: words met while reading or added by hand, reviewed with everything else. */
	words: {
		/**
		 * Adds a word, from a selection in the reader (with its sentence and section) or by hand.
		 * Without `meaning`, the member's AI defines it in its sentence, in the background; with
		 * no key, the meaning is needed. A word already in the vocabulary returns that card, with
		 * its first sentence, as `existing`; a removed one comes back. The client picks the id.
		 */
		add: oc
			.input(
				z.object({
					id: z.uuid(),
					form: z.string().trim().min(1, 'Type a word.').max(MAX_WORD_CHARS, 'That is longer than a word or a short term.'),
					sentence: z.string().trim().max(600, 'Use one sentence.').optional(),
					meaning: z.string().trim().max(500, 'Keep the meaning to a line or two.').optional(),
					sectionId: z.uuid().optional(),
				}),
			)
			.output(z.object({ word: Word, existing: z.boolean() })),
		/** Every word, newest first. */
		list: oc.output(z.array(Word)),
		/** Words worth learning in a section that the member has not kept yet. */
		suggestions: oc.input(z.object({ sectionId: z.uuid() })).output(z.array(Suggestion)),
		/** Sets what a word means. */
		update: oc.input(z.object({ id: z.uuid(), meaning: z.string().trim().min(1, 'Add what it means.').max(500, 'Keep the meaning to a line or two.') })).output(Word),
		/** Takes a word out of the vocabulary and the review queue; `restore` brings it back (undo). */
		remove: oc.input(z.object({ id: z.uuid() })).output(Ok),
		restore: oc.input(z.object({ id: z.uuid() })).output(Word),
	},
	skills: {
		/** The member's skills, not archived, in the order they were added. */
		list: oc.output(z.array(Skill)),
		get: oc.input(z.object({ id: z.uuid() })).output(SkillDetail),
		/** Adds a skill. The client picks the id; a retry returns the same skill. */
		create: oc
			.input(z.object({ id: z.uuid(), name: SkillName, goal: SkillGoal.optional(), weeklyMinutes: WeeklyMinutes.optional() }))
			.output(Skill),
		/** Renames a skill or changes its goal or target; an empty goal or a null target clears it. */
		update: oc
			.input(z.object({ id: z.uuid(), name: SkillName.optional(), goal: SkillGoal.optional(), weeklyMinutes: WeeklyMinutes.nullable().optional() }))
			.output(Skill),
		/** Hides a skill from the lists; its practice entries stay. `restore` brings it back (undo). */
		archive: oc.input(z.object({ id: z.uuid() })).output(Ok),
		restore: oc.input(z.object({ id: z.uuid() })).output(Skill),
	},
	teach: {
		/**
		 * Starts teaching an idea back, with the member's own AI key. Only idea cards can be taught.
		 * The client picks the id; starting again with it returns the same session.
		 */
		start: oc.input(z.object({ id: z.uuid(), cardId: z.uuid() })).output(TeachSession),
		/**
		 * The learner's next message, and the student's turn: a follow-up, or the summing up after the
		 * third. `turn` counts the learner's earlier messages, so a retried request is not sent twice;
		 * after a failed AI call, the same turn asks the student again. Gaps bring the card back within
		 * 10 minutes, with its memory unchanged.
		 */
		reply: oc
			.input(
				z.object({
					id: z.uuid(),
					turn: z.int().min(0).max(3),
					text: z.string().trim().min(1, 'Write your explanation first.').max(MAX_TEACH_CHARS, 'Keep it shorter: a few paragraphs at most.'),
				}),
			)
			.output(TeachSession),
		get: oc.input(z.object({ id: z.uuid() })).output(TeachSession),
	},
}

export type Contract = typeof contract
