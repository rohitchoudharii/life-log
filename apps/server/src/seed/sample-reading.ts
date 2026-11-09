import { createHash } from 'node:crypto'
import { type Block, countWords, blockText, defaultScheduler, type QuestionLevel } from '@life-log-club/domain'
import { and, eq, isNull } from 'drizzle-orm'
import type { Tx } from '../db/client'
import { cards, preferences, questions, readings, sections } from '../db/schema'
import { preferencesOf } from '../learning/preferences'

export const SAMPLE_TITLE = 'How to remember what you read'
const PROMPT_VERSION = 'sample-v1'

type Idea = {
	idea: string
	cue: string
	/** A sentence of the section, exactly as written there. */
	quote: string
	question: { level: QuestionLevel; prompt: string; reference: string; mustHave: string[]; misconceptions: string[] }
}
type SampleSection = { title: string; paragraphs: string[]; ideas: Idea[] }

/**
 * The sample every member gets on their first visit to Mind, so the whole loop works before they
 * add a reading or an AI key: read, recall, check, review. It is about the app's own method, and
 * its key ideas, cues and questions are written here instead of by AI.
 */
export const SAMPLE: SampleSection[] = [
	{
		title: 'Rereading feels like learning',
		paragraphs: [
			'You finish a chapter, close the book, and feel that you know it. A week later, almost nothing is left. This happens to everyone, and it is not a sign of a bad memory. It is a sign that reading and remembering are two different skills, and most of us only practise the first one.',
			'When you reread a page, the words look familiar. Familiar text is easy to process, and the brain takes that ease as a sign that the material is learned. Psychologists call this an illusion of fluency. The feeling is real, but it measures how well you recognise the text, not how well you can bring it back without the page in front of you.',
			'Recognising and recalling are not the same. You can recognise a face you could never describe, and you can nod along to an argument you could never rebuild. Everyday life asks for recall: in a meeting, in an exam, or when you try to explain an idea to a friend. Nobody shows you the page first.',
			'This gap explains a common surprise. A student reads the notes the night before an exam, feels ready, and then stares at the first question. The notes were never the problem. The problem is that the student only ever practised looking at them, and the exam asks for something else: bringing the ideas back with the notes closed.',
			'The good news is that the cure is simple. Each time you pull an idea out of memory, you make that memory stronger and easier to find the next time. This is called the testing effect, or retrieval practice. In one well-known study, students who read a text once and then tried to recall it remembered far more a week later than students who read it four times.',
			'Retrieval works even when it feels worse. Rereading feels smooth; recalling feels slow and full of gaps. That effort is not a sign that it is failing. Researchers call such effort a desirable difficulty: work that makes learning feel harder in the moment and makes it last longer.',
			'So the first rule of this app is plain. Read a section once, with attention. Then close it and try to bring it back.',
		],
		ideas: [
			{
				idea: 'Rereading creates an illusion of fluency: familiar text feels learned, but that feeling measures recognition, not recall.',
				cue: 'Why does a page you have reread feel known when it is not?',
				quote: 'Familiar text is easy to process, and the brain takes that ease as a sign that the material is learned.',
				question: {
					level: 'explain',
					prompt: 'Why can a chapter you have read twice still be gone a week later, even though it felt familiar?',
					reference:
						'Rereading makes the text familiar, and familiar text feels learned. But that ease shows you can recognise the words, not recall the ideas without the page, so the feeling of knowing is an illusion of fluency.',
					mustHave: ['Familiar text feels easy, and that ease is mistaken for learning', 'Recognising the text is not the same as recalling it without the page'],
					misconceptions: ['Forgetting after rereading means you have a bad memory'],
				},
			},
			{
				idea: 'Recognising something is not the same as recalling it, and everyday life asks for recall.',
				cue: 'Which kind of remembering does a meeting or an exam ask of you?',
				quote: 'Recognising and recalling are not the same.',
				question: {
					level: 'apply',
					prompt: "You follow every step of a colleague's argument while they talk, but the next day you can't explain it to your manager. What does this show?",
					reference:
						'Following the argument was recognition: the steps were in front of you. Explaining it the next day needs recall, bringing it back with nothing shown. Being able to do the first says little about the second.',
					mustHave: ['Following along is recognition, with the material in front of you', 'Explaining it later needs recall, with nothing shown'],
					misconceptions: [],
				},
			},
			{
				idea: 'Each time you pull an idea out of memory, the memory gets stronger, so recalling beats rereading even though it feels harder.',
				cue: 'What beats reading a text four times?',
				quote: 'Each time you pull an idea out of memory, you make that memory stronger and easier to find the next time.',
				question: {
					level: 'explain',
					prompt: 'Why does trying to recall a text, which feels slow and full of gaps, beat rereading it?',
					reference:
						'Pulling an idea out of memory strengthens that memory and makes it easier to find next time. The effort that makes recall feel worse is a desirable difficulty: it is part of why the learning lasts.',
					mustHave: ['Retrieving an idea strengthens the memory of it', 'The effort is a desirable difficulty, not a sign of failure'],
					misconceptions: ['If recalling feels hard, it is not working'],
				},
			},
		],
	},
	{
		title: 'Write it down from memory',
		paragraphs: [
			'The simplest way to practise recall is a brain dump. Right after you read a section, hide the text and write down everything you remember. Lists, fragments and half sentences are fine. You are not writing for anyone else; you are finding out what stuck.',
			'A blank page is a better test than a list of questions. Questions give away what matters and in which order. When you start from nothing, you have to rebuild the structure yourself, and that act of building is what makes the ideas your own. Psychologists call the benefit of producing an answer, rather than reading it, the generation effect.',
			'The dump also shows you the shape of your own understanding. Ideas you can explain come out in full sentences. Ideas you only half understand come out as a single word or a vague phrase. Gaps that rereading would hide become obvious on a page you wrote yourself.',
			"Then compare. Look back at the section, idea by idea, and mark each one: did you get it, partly get it, or miss it? Be strict. Naming a term without saying what it means counts as partly at best. The point is not a good score; the point is an honest map of what you know and what you don't.",
			'Feedback matters most right here. A wrong idea that is never corrected tends to stay, and it can feel just as true as a right one. Seeing the correct version soon after a mistake replaces it. That is why this app shows each idea, with the sentence it comes from, as soon as your recall check ends.',
			'Sometimes nothing comes to mind at all. That still counts. Trying to recall, even when it fails, prepares the memory to take in the answer when you see it next. An honest blank is worth more than a quick look back at the page.',
			'After the dump come a few questions, one for each key idea. Ideas you missed are asked first, in their simplest form. Ideas you already covered get a harder question, a why or a how, because asking for the same fact twice teaches little.',
		],
		ideas: [
			{
				idea: 'Start a recall check from a blank page, not from questions: rebuilding the structure yourself is what makes the ideas your own (the generation effect).',
				cue: 'What is the first thing to do after reading a section, and why that way?',
				quote: 'When you start from nothing, you have to rebuild the structure yourself, and that act of building is what makes the ideas your own.',
				question: {
					level: 'explain',
					prompt: 'Why is writing everything you remember on an empty page a better test than answering a list of questions?',
					reference:
						'Questions give away what matters and in which order. On an empty page you have to rebuild the structure yourself, and producing it, rather than reading it, is what makes the ideas stick: the generation effect.',
					mustHave: ['Questions give away what matters and the order', 'Rebuilding the structure yourself makes the ideas stick'],
					misconceptions: [],
				},
			},
			{
				idea: 'Compare the dump with the text soon after and mark each idea strictly, because an uncorrected mistake stays and feels as true as a right idea.',
				cue: 'Why check your recall against the text straight away?',
				quote: 'A wrong idea that is never corrected tends to stay, and it can feel just as true as a right one.',
				question: {
					level: 'apply',
					prompt: 'A friend writes a brain dump after each chapter but never looks back at the book. What risk do they run, and what should they change?',
					reference:
						'Mistakes in their dumps are never corrected, so wrong ideas stay and feel as true as right ones. They should compare each dump with the text soon after, idea by idea, and mark each one strictly.',
					mustHave: ['Uncorrected mistakes stay and feel true', 'Compare with the text soon after, idea by idea'],
					misconceptions: [],
				},
			},
			{
				idea: 'A failed attempt to recall still helps: it prepares the memory to take in the answer when you see it next.',
				cue: 'Is it worth trying to recall when nothing comes to mind?',
				quote: 'Trying to recall, even when it fails, prepares the memory to take in the answer when you see it next.',
				question: {
					level: 'explain',
					prompt: 'Nothing comes to mind after a section. Why write that down honestly instead of peeking at the text first?',
					reference:
						'Trying to recall, even when it fails, prepares the memory to take in the answer when you see it next. A quick look skips that effort, so the answer goes in less well.',
					mustHave: ['A failed attempt still prepares the memory for the answer', 'Looking back skips the effort'],
					misconceptions: [],
				},
			},
		],
	},
	{
		title: 'Come back just before you forget',
		paragraphs: [
			'Memories fade fast at first and then more slowly. Hermann Ebbinghaus showed this in the 1880s by learning lists of nonsense syllables and testing himself after different delays. Most of what he lost, he lost in the first day. What was left after a week lasted much longer.',
			'Each successful recall flattens that curve. The best time to recall an idea is just before you would forget it: late enough that it takes effort, early enough that you still succeed. Spreading reviews out this way is called spaced repetition, and it is one of the most reliable findings in the science of learning.',
			'This app schedules that for you. A new idea comes back after one day, then two days, then three. After that, the gap grows with each right answer, to weeks and then months. An idea you miss comes back in ten minutes and starts its steps again. You never have to plan a review; the app tells you when one is due.',
			'You do not need a daily habit for this to work. If you skip a week, the ideas wait. The ones you are most likely to have forgotten come first, and you can stop after a few minutes. Missing a day costs a little, not everything.',
			'Short sessions are enough. A review of twenty ideas takes most people under ten minutes, and each idea needs only a few reviews before its gaps grow to months. Over a year, that adds up to hundreds of ideas kept for the cost of a few minutes on the days you choose.',
			'Before each answer, the app asks how sure you are. This is not a trick. People often feel sure about ideas they have wrong, and those confident mistakes are the ones most worth fixing. When you find out you were wrong about something you were sure of, the correction sticks surprisingly well.',
			'Read, recall, check, and come back at the right time. That is the whole method. The rest of this app exists to make each step take one or two clicks.',
		],
		ideas: [
			{
				idea: 'Memories fade fastest in the first day; what survives a week lasts much longer.',
				cue: 'When does most forgetting happen after you learn something?',
				quote: 'Most of what he lost, he lost in the first day.',
				question: {
					level: 'explain',
					prompt: 'Why does this app bring a new idea back after only one day?',
					reference:
						'Forgetting is fastest at first: most of what is lost goes in the first day. Recalling an idea after a day catches it before it fades and flattens the forgetting curve.',
					mustHave: ['Most forgetting happens in the first day', 'An early recall catches the idea before it fades'],
					misconceptions: [],
				},
			},
			{
				idea: 'Recall an idea just before you would forget it, late enough to take effort and early enough to succeed: that is spaced repetition.',
				cue: 'What is the best moment to review an idea?',
				quote: 'The best time to recall an idea is just before you would forget it: late enough that it takes effort, early enough that you still succeed.',
				question: {
					level: 'apply',
					prompt: 'You have ten ideas from a book you finished today. Plan when to review them over the next week, and say why.',
					reference:
						'Review each idea after one day, then two days, then three, with the gaps growing after each right answer. Each review should come just before you would forget: late enough that it takes effort, early enough that you still succeed.',
					mustHave: ['Gaps that grow: one day, then two, then three', 'Each review just before forgetting, so it takes effort but succeeds'],
					misconceptions: ['Reviewing every idea every day is best'],
				},
			},
			{
				idea: 'Confident mistakes are the most worth finding: an error you were sure of, once corrected, sticks surprisingly well.',
				cue: 'Why does the app ask how sure you are before each answer?',
				quote: 'When you find out you were wrong about something you were sure of, the correction sticks surprisingly well.',
				question: {
					level: 'explain',
					prompt: 'Why are the mistakes you were sure about the ones most worth finding?',
					reference:
						'People often feel sure about ideas they have wrong, so those errors would never be checked. And when a confident error is corrected, the correction sticks surprisingly well.',
					mustHave: ['People are often sure about ideas they have wrong', 'A corrected confident error sticks well'],
					misconceptions: [],
				},
			},
		],
	},
]

/** A fixed id for one row of a member's sample, so adding it twice adds nothing. */
function sampleId(userId: string, key: string) {
	const h = createHash('sha256').update(`sample-reading:${userId}:${key}`).digest('hex')
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((Number.parseInt(h[16]!, 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

export const sampleReadingId = (userId: string) => sampleId(userId, 'reading')

/**
 * Adds the sample reading for a member who has never had it, and remembers that it was added, so
 * it never comes back after the member removes it. Returns whether it was added now.
 */
export async function addSampleReading(tx: Tx, userId: string) {
	const { sampleAddedAt } = await preferencesOf(tx, userId)
	if (sampleAddedAt) return false
	const claimed = await tx
		.update(preferences)
		.set({ sampleAddedAt: new Date() })
		.where(and(eq(preferences.userId, userId), isNull(preferences.sampleAddedAt)))
		.returning({ userId: preferences.userId })
	if (!claimed.length) return false

	const readingId = sampleReadingId(userId)
	const drafts = SAMPLE.map((s) => {
		const blocks: Block[] = s.paragraphs.map((text) => ({ type: 'paragraph', text }))
		return { ...s, blocks, wordCount: blocks.reduce((n, b) => n + countWords(blockText(b)), 0) }
	})
	await tx
		.insert(readings)
		.values({
			id: readingId,
			userId,
			title: SAMPLE_TITLE,
			author: 'Life Log Club',
			source: 'sample',
			status: 'ready',
			wordCount: drafts.reduce((n, s) => n + s.wordCount, 0),
		})
		.onConflictDoNothing()
	for (const [position, s] of drafts.entries()) {
		const sectionId = sampleId(userId, `section:${position}`)
		await tx
			.insert(sections)
			.values({
				id: sectionId,
				userId,
				readingId,
				position,
				level: 1,
				title: s.title,
				blocks: s.blocks,
				wordCount: s.wordCount,
				// Written here, not by AI, so nothing waits on a key.
				writeStatus: 'ready',
				promptVersion: PROMPT_VERSION,
			})
			.onConflictDoNothing()
		for (const [k, idea] of s.ideas.entries()) {
			const cardId = sampleId(userId, `card:${position}:${k}`)
			await tx
				.insert(cards)
				.values({
					id: cardId,
					userId,
					kind: 'idea',
					readingId,
					sectionId,
					position: k,
					origin: 'ai',
					prompt: idea.cue,
					answer: idea.idea,
					quote: idea.quote,
					state: defaultScheduler.initial(),
				})
				.onConflictDoNothing()
			const { level, ...content } = idea.question
			await tx
				.insert(questions)
				.values({
					id: sampleId(userId, `question:${position}:${k}`),
					userId,
					cardId,
					readingId,
					sectionId,
					type: 'short_answer',
					level,
					content: { ...content, niceToHave: [] },
					promptVersion: PROMPT_VERSION,
				})
				.onConflictDoNothing()
		}
	}
	return true
}
