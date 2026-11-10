import { expect, type Page, test } from '@playwright/test'
import { graduate, sql } from './db'
import { FAKE_SITE, GOOD_ANTHROPIC_KEY } from './env'
import { testEpub } from '../apps/server/src/import/test-books'
import { proof } from './proof'
import { joinAs } from './session'

async function addLink(page: Page, url: string) {
	await page.getByLabel('Add a reading').fill(url)
	await page.getByRole('button', { name: 'Add', exact: true }).click()
}
const sectionTitle = (page: Page) => page.locator('article h2')
/** Calls the API from the page, with the page's own session. */
const api = (page: Page, path: string, json: unknown) =>
	page.request.post(`/rpc/${path}`, { headers: { 'x-csrf-token': 'orpc' }, data: { json } })
const writeStatus = (sectionId: string) =>
	sql<{ write_status: string }>('select write_status from sections where id = $1', [sectionId]).then((r) => r[0]!.write_status)
/** A member with an AI key, on Mind, who adds the article and opens it at its first section. */
async function openWithKey(page: Page) {
	await page.clock.install()
	await joinAs(page)
	expect((await api(page, 'ai/saveKey', { provider: 'anthropic', apiKey: GOOD_ANTHROPIC_KEY })).ok()).toBe(true)
	await page.goto('/mind')
	await addLink(page, `${FAKE_SITE}/articles/execution-model`)
	const reading = page.getByTestId('reading').first()
	await expect(reading.getByText(/sections/)).toBeVisible({ timeout: 15_000 })
	await reading.getByRole('link').first().click()
	await expect(sectionTitle(page)).toBeVisible()
	const readingId = new URL(page.url()).pathname.split('/').at(-1)!
	return { readingId, ids: await sectionIds(readingId) }
}
/** Stays in the open section, active, for 31 seconds of fake time. */
async function stay(page: Page) {
	await page.mouse.move(10, 10)
	await page.clock.runFor(15_000)
	await page.mouse.move(20, 20)
	await page.clock.runFor(16_000)
}
const seenAt = (sectionId: string) =>
	sql<{ first_seen_at: Date | null }>('select first_seen_at from sections where id = $1', [sectionId]).then((r) => r[0]!.first_seen_at)
const sectionIds = (readingId: string) =>
	sql<{ id: string }>('select id from sections where reading_id = $1 order by position', [readingId]).then((r) => r.map((s) => s.id))

test('Continue opens the section where the member stopped, and a section is seen after 30 seconds in it', async ({ page }, testInfo) => {
	// Fake timers that still run on their own, so the 30 seconds can be skipped through.
	await page.clock.install()
	await joinAs(page)
	await page.goto('/mind')
	await addLink(page, `${FAKE_SITE}/articles/execution-model`)
	const reading = page.getByTestId('reading').first()
	await expect(reading.getByText(/sections/)).toBeVisible({ timeout: 15_000 })
	// Not opened yet: nothing to continue.
	await expect(reading.getByRole('link', { name: 'Continue' })).toHaveCount(0)

	await reading.getByRole('link').first().click()
	await expect(sectionTitle(page)).toBeVisible()
	const readingId = new URL(page.url()).pathname.split('/').at(-1)!
	const [first, second] = await sectionIds(readingId)
	await page.getByRole('button', { name: 'Next section' }).click()
	const secondTitle = await sectionTitle(page).innerText()

	// Leave, then come back with Continue: the reading opens at section 2.
	await page.goto('/mind')
	await expect(reading.getByRole('link', { name: 'Continue' })).toBeVisible()
	await proof(page, testInfo, 'continue-on-mind')
	await reading.getByRole('link', { name: 'Continue' }).click()
	await expect(sectionTitle(page)).toHaveText(secondTitle)
	await proof(page, testInfo, 'opened-at-section-2')

	// Seen only after 30 seconds in the section, with the member active.
	await page.mouse.move(10, 10)
	await page.clock.runFor(25_000)
	expect(await seenAt(second!)).toBeNull()
	await page.mouse.move(20, 20)
	await page.clock.runFor(6_000)
	await expect.poll(() => seenAt(second!)).not.toBeNull()
	// The first section was open for a moment only.
	expect(await seenAt(first!)).toBeNull()
})

test('reloading keeps the place within a section, 2 seconds after scrolling stops', async ({ page }) => {
	await joinAs(page)
	await page.goto('/mind')
	await addLink(page, `${FAKE_SITE}/articles/execution-model`)
	const reading = page.getByTestId('reading').first()
	await expect(reading.getByText(/sections/)).toBeVisible({ timeout: 15_000 })
	await reading.getByRole('link').first().click()
	await expect(sectionTitle(page)).toBeVisible()
	// Go on to a section too long for one screen.
	const tall = () => page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight * 2)
	while (!(await tall())) {
		await page.getByRole('button', { name: 'Next section' }).click()
		await expect(page.locator('article [data-block]').first()).toBeVisible()
	}

	const blocks = page.locator('article [data-block]')
	const last = (await blocks.count()) - 1
	await blocks.nth(last).scrollIntoViewIfNeeded()
	const readingId = new URL(page.url()).pathname.split('/').at(-1)!
	const saved = () => sql<{ position: { block: number } | null }>('select position from readings where id = $1', [readingId]).then((r) => r[0]!.position?.block ?? 0)
	await expect.poll(saved).toBeGreaterThan(0)

	// Reopened, the block that was at the top of the screen is at the top again.
	const block = await saved()
	await page.reload()
	await expect(blocks.nth(block)).toBeInViewport()
	await expect.poll(() => blocks.nth(block).evaluate((b) => Math.round(b.getBoundingClientRect().top))).toBeLessThan(200)
})

test('30 seconds in a section writes its key ideas, each resting on a quote from it, with one question each', async ({ page }, testInfo) => {
	const { ids } = await openWithKey(page)
	const [first, second] = ids
	expect(await writeStatus(first!)).toBe('none')
	await stay(page)
	await expect.poll(() => writeStatus(first!), { timeout: 15_000 }).toBe('ready')
	await proof(page, testInfo, 'section-read-ideas-written')

	const ideas = await sql<{ id: string; answer: string; quote: string; started_at: Date | null }>(
		"select id, answer, quote, started_at from cards where section_id = $1 and origin = 'ai' order by position",
		[first],
	)
	expect(ideas.length).toBeGreaterThanOrEqual(2)
	// Every quote is in the section's own text, and the invented idea the fake AI added is gone.
	const section = await (await api(page, 'readings/section', { id: first })).json()
	expect(section.json).toMatchObject({ writeStatus: 'ready', keyIdeas: ideas.length })
	const text = JSON.stringify(section.json.blocks)
	for (const idea of ideas) expect(text).toContain(idea.quote)
	expect(ideas.map((i) => i.answer)).not.toContain('An idea the text never states.')
	// Not started: an idea waits for its first recall before it is in Review.
	expect(ideas.every((i) => i.started_at === null)).toBe(true)
	const perCard = await sql<{ n: number }>('select count(*)::int as n from questions where card_id = any($1) and retired_at is null group by card_id', [ideas.map((i) => i.id)])
	expect(perCard.map((r) => r.n)).toEqual(ideas.map(() => 1))
	// A section the member hasn't read yet is not written.
	expect(await writeStatus(second!)).toBe('none')
	const calls = await sql<{ purpose: string }>('select purpose from ai_calls where user_id = (select user_id from sections where id = $1) order by at', [first])
	expect(calls.map((c) => c.purpose)).toEqual(['write-section', 'check-questions'])
})

test("past this month's AI budget a newly read section stays paused, and Mind says so", async ({ page }, testInfo) => {
	const { ids } = await openWithKey(page)
	expect((await api(page, 'preferences/update', { aiMonthlyBudgetUsd: 0 })).ok()).toBe(true)
	await stay(page)
	await expect.poll(() => writeStatus(ids[0]!), { timeout: 15_000 }).toBe('paused')
	expect(await sql("select id from cards where section_id = $1", [ids[0]])).toEqual([])

	await page.goto('/mind')
	await expect(page.getByRole('status').filter({ hasText: 'Paused writing questions' })).toBeVisible()
	await proof(page, testInfo, 'mind-paused')

	// Raising the budget writes the paused section.
	expect((await api(page, 'preferences/update', { aiMonthlyBudgetUsd: 5 })).ok()).toBe(true)
	await expect.poll(() => writeStatus(ids[0]!), { timeout: 15_000 }).toBe('ready')
})

const DAY_MINUTES = 24 * 60
const minutesUntil = (at: Date) => Math.round((at.getTime() - Date.now()) / 60_000)
type IdeaRow = { id: string; answer: string; prompt: string; level: number; due_at: Date; started_at: Date | null }
/** The section's key ideas in order, with each card's state now. A card's prompt is its cue. */
const ideasOf = (sectionId: string) =>
	sql<IdeaRow>(
		"select id, answer, prompt, level, due_at, started_at from cards where section_id = $1 and origin = 'ai' and deleted_at is null order by position",
		[sectionId],
	)
const attemptIdOf = (page: Page) => new URL(page.url()).pathname.split('/').at(-1)!
/** Answers the question on screen: writes `text` and clicks a confidence button, or clicks I don't know. */
async function answerShown(page: Page, text: string | null, confidence: 'Guessing' | 'Think so' | 'Sure' = 'Sure') {
	const before = await page.getByTestId('question').innerText()
	if (text === null) await page.getByRole('button', { name: 'I don’t know' }).click()
	else {
		await page.getByLabel('Your answer').fill(text)
		await page.getByRole('button', { name: confidence, exact: true }).click()
	}
	// The next question, or the results, replaces this one.
	await expect(page.getByTestId('question').filter({ hasText: before })).toHaveCount(0, { timeout: 15_000 })
}
/** The key idea whose question is on screen: by its cue, or by the stored question's number. */
async function shownIdea(page: Page, ideas: IdeaRow[]) {
	const text = await page.getByTestId('question').innerText()
	const cue = ideas.find((i) => i.prompt === text)
	if (cue) return { idea: cue, isCue: true }
	const n = Number(text.match(/point (\d+)/)?.[1])
	return { idea: ideas[n - 1]!, isCue: false }
}
const recallLog = (attemptId: string) =>
	sql<{ card_id: string; mode: string; ask: string; rating: string; correct: boolean; confidence: string | null }>(
		'select card_id, mode, ask, rating, correct, confidence from review_log where attempt_id = $1 order by reviewed_at',
		[attemptId],
	)

test('after reading, Recall asks one question per idea, missed ideas first, and shows the results only after the last answer', async ({ page }, testInfo) => {
	const { ids } = await openWithKey(page)
	await stay(page)
	await expect.poll(() => writeStatus(ids[0]!), { timeout: 15_000 }).toBe('ready')
	const ideas = await ideasOf(ids[0]!)
	expect(ideas).toHaveLength(3)
	const title = await sectionTitle(page).innerText()

	const recall = page.getByRole('button', { name: 'Recall this section' })
	await recall.scrollIntoViewIfNeeded()
	await proof(page, testInfo, 'recall-card')
	await recall.click()
	await expect(page).toHaveURL(/\/mind\/recall\//)
	// The text is hidden: only the section's title and one box.
	await expect(page.getByRole('heading', { name: title })).toBeVisible()
	await expect(page.locator('article')).toHaveCount(0)
	const box = page.getByLabel('What you remember')
	await expect(box).toBeFocused()
	await expect(page.getByRole('button', { name: 'Done' })).toBeDisabled()
	// The recall start screen has the Guess first switch, on by default.
	await expect(page.getByRole('switch', { name: /Guess first/ })).toBeChecked()
	// The dump brings back the first idea and nothing else.
	await box.fill(`I remember this: ${ideas[0]!.answer}`)
	await proof(page, testInfo, 'brain-dump')
	await page.getByRole('button', { name: 'Done' }).click()
	const attemptId = attemptIdOf(page)

	// The two missed ideas come first, each asked through its cue: the simplest retrieval.
	await expect(page.getByText('Question 1 of 3')).toBeVisible({ timeout: 15_000 })
	await expect(page.getByLabel('Your answer')).toBeFocused()
	await expect(page.getByRole('button', { name: 'Sure', exact: true })).toBeDisabled()
	await expect(page.getByRole('list', { name: 'Recall map' })).toHaveCount(0)
	// No card has started yet; the dump only set the level each one starts at.
	expect((await ideasOf(ids[0]!)).map((i) => [i.started_at, i.level])).toEqual([
		[null, 1],
		[null, 0],
		[null, 0],
	])
	await proof(page, testInfo, 'question-missed-cue')
	const q1 = await shownIdea(page, ideas)
	expect(q1).toMatchObject({ isCue: true })
	expect(q1.idea.id).not.toBe(ideas[0]!.id)
	// Right, but only a guess.
	await answerShown(page, q1.idea.answer, 'Guessing')

	await expect(page.getByText('Question 2 of 3')).toBeVisible()
	const q2 = await shownIdea(page, ideas)
	expect(q2).toMatchObject({ isCue: true })
	expect([ideas[0]!.id, q1.idea.id]).not.toContain(q2.idea.id)
	// Sure, and wrong.
	await answerShown(page, 'Something about bananas', 'Sure')
	// Nothing of the results shows before the last answer, on screen or from the API.
	const midway = await (await api(page, 'recall/get', { id: attemptId })).json()
	expect(midway.json).toMatchObject({ ideas: null, retry: null })
	await expect(page.getByRole('list', { name: 'Recall map' })).toHaveCount(0)
	await expect(page.getByTestId('result')).toHaveCount(0)

	// The covered idea comes last, with a stored question above recall, not its cue.
	await expect(page.getByText('Question 3 of 3')).toBeVisible()
	const q3 = await shownIdea(page, ideas)
	expect(q3).toMatchObject({ isCue: false, idea: { id: ideas[0]!.id } })
	await expect(page.getByTestId('question')).toHaveText(/^Why does point 1 of this part matter/)
	await proof(page, testInfo, 'question-covered-deeper')
	await answerShown(page, ideas[0]!.answer, 'Think so')

	const map = page.getByRole('list', { name: 'Recall map' })
	await expect(map.locator(':scope > li')).toHaveCount(3)
	await expect(page.getByText('You brought back 1 of 3 key ideas, and answered 2 of 3 questions right.')).toBeVisible()
	// Sure but wrong comes first: those errors are the ones most worth fixing.
	const sure = page.getByRole('region', { name: 'You were sure about these' })
	await expect(sure).toContainText(q2.idea.answer)
	await expect(sure).not.toContainText(q1.idea.answer)
	const coveredItem = map.locator(':scope > li').filter({ hasText: ideas[0]!.answer }).first()
	await expect(coveredItem).toContainText('Covered')
	await expect(coveredItem).toContainText('Right')
	await expect(coveredItem).toContainText('Model answer')
	await expect(coveredItem).toContainText('Back tomorrow')
	const wrongItem = map.locator(':scope > li').filter({ hasText: 'You wrote: Something about bananas' })
	await expect(wrongItem).toContainText('Missed')
	await expect(wrongItem).toContainText('Not quite')
	await expect(wrongItem).toContainText('Back in 10 minutes')
	await proof(page, testInfo, 'recall-results')

	// Each card started from its answer: its start level moved one up when right, one down (to no lower than 0) when wrong.
	const after = await ideasOf(ids[0]!)
	const card = (id: string) => after.find((i) => i.id === id)!
	expect(card(ideas[0]!.id)).toMatchObject({ level: 2, started_at: expect.any(Date) })
	expect(card(q1.idea.id)).toMatchObject({ level: 1, started_at: expect.any(Date) })
	expect(card(q2.idea.id)).toMatchObject({ level: 0, started_at: expect.any(Date) })
	// Covered and right is back tomorrow; a right guess counts as hard, also a day; a miss is back in 10 minutes.
	expect(Math.abs(minutesUntil(card(ideas[0]!.id).due_at) - DAY_MINUTES)).toBeLessThanOrEqual(1)
	expect(Math.abs(minutesUntil(card(q1.idea.id).due_at) - DAY_MINUTES)).toBeLessThanOrEqual(1)
	expect(minutesUntil(card(q2.idea.id).due_at)).toBe(10)
	expect(await recallLog(attemptId)).toEqual([
		{ card_id: q1.idea.id, mode: 'recall', ask: 'cue', rating: 'hard', correct: true, confidence: 'guessing' },
		{ card_id: q2.idea.id, mode: 'recall', ask: 'cue', rating: 'again', correct: false, confidence: 'sure' },
		{ card_id: ideas[0]!.id, mode: 'recall', ask: 'question', rating: 'good', correct: true, confidence: 'think_so' },
	])

	// The dump can be personal, so only its encrypted form is stored.
	const [stored] = await sql<{ text_ct: string }>('select text_ct from recall_attempts where id = $1', [attemptId])
	expect(stored!.text_ct).not.toContain('I remember this')
	await page.getByText('What you wrote').click()
	await expect(page.getByText(`I remember this: ${ideas[0]!.answer}`)).toBeVisible()
	expect((await sql('select recalled_at from sections where id = $1', [ids[0]]))[0]).toMatchObject({ recalled_at: expect.any(Date) })

	// Retry missed ideas asks the wrong one again through its cue, as practice: the schedule stays.
	await page.getByRole('button', { name: 'Retry missed ideas' }).click()
	await expect(page.getByText('Retry 1 of 1 · practice, your schedule stays as it is')).toBeVisible()
	await expect(page.getByTestId('question')).toHaveText(q2.idea.prompt)
	await page.getByLabel('Your answer').fill(q2.idea.answer)
	await page.getByRole('button', { name: 'Sure', exact: true }).click()
	await expect(page.getByTestId('result')).toContainText('Right')
	await proof(page, testInfo, 'retry-practice')
	const retried = await ideasOf(ids[0]!)
	expect(retried.find((i) => i.id === q2.idea.id)).toMatchObject({ level: 0, due_at: card(q2.idea.id).due_at })
	expect((await recallLog(attemptId)).at(-1)).toMatchObject({ card_id: q2.idea.id, mode: 'practice', correct: true })
	await page.getByRole('button', { name: 'Next' }).click()
	await expect(page.getByText('That was every missed idea.')).toBeVisible()
	await page.getByRole('button', { name: 'Back to the results' }).click()
	await expect(page.getByRole('button', { name: 'Retry missed ideas' })).toHaveCount(0)

	// Done goes on reading at the next section.
	const [next] = await sql<{ title: string }>('select title from sections where id = $1', [ids[1]])
	await page.getByRole('button', { name: 'Done' }).click()
	await expect(sectionTitle(page)).toHaveText(next!.title)
})

test('Recall on a section not written yet opens the dump at once; Nothing comes to mind, then I don’t know on each cue, keeps every idea due in 10 minutes', async ({
	page,
}, testInfo) => {
	const { ids } = await openWithKey(page)
	expect(await writeStatus(ids[0]!)).toBe('none')
	await page.getByRole('button', { name: 'Recall this section' }).click()
	await expect(page.getByLabel('What you remember')).toBeVisible()
	await page.getByRole('button', { name: 'Nothing comes to mind' }).click()
	// The ideas are still being written: the member waits on one calm line.
	await expect(page.getByRole('status').filter({ hasText: 'Checking against the text…' })).toBeVisible()
	await proof(page, testInfo, 'checking')

	// Every idea was missed, so every question is its cue.
	await expect(page.getByText(/^Question 1 of \d+$/)).toBeVisible({ timeout: 15_000 })
	const ideas = await ideasOf(ids[0]!)
	expect(ideas.length).toBeGreaterThanOrEqual(2)
	for (let n = 1; n <= ideas.length; n++) {
		await expect(page.getByText(`Question ${n} of ${ideas.length}`)).toBeVisible()
		expect(await shownIdea(page, ideas)).toMatchObject({ isCue: true })
		await answerShown(page, null)
	}

	const map = page.getByRole('list', { name: 'Recall map' })
	await expect(map.locator(':scope > li')).toHaveCount(ideas.length)
	await expect(map.getByText('Covered')).toHaveCount(0)
	await expect(map.getByText('Vague')).toHaveCount(0)
	await expect(map.getByText('Not answered')).toHaveCount(ideas.length)
	await expect(map.locator(':scope > li').first()).toContainText('Back in 10 minutes')
	// I don't know is an honest miss, not a confident error.
	await expect(page.getByRole('region', { name: 'You were sure about these' })).toHaveCount(0)
	await proof(page, testInfo, 'nothing-comes-to-mind')
	for (const card of await ideasOf(ids[0]!)) {
		expect(card).toMatchObject({ level: 0, started_at: expect.any(Date) })
		expect(minutesUntil(card.due_at)).toBe(10)
	}
	// An empty dump and skipped answers need no AI call.
	const calls = await sql<{ purpose: string }>(
		"select purpose from ai_calls where user_id = (select user_id from sections where id = $1) and purpose in ('grade-recall', 'judge-answer')",
		[ids[0]],
	)
	expect(calls).toEqual([])
})

/** Moves a card's due time into the past, as if the days had passed. */
const makeDue = (id: string) => sql(`update cards set due_at = now() - interval '1 second' where id = $1`, [id])
const cardNow = (id: string) => sql<{ level: number; due_at: Date }>('select level, due_at from cards where id = $1', [id]).then((r) => r[0]!)

// The Release 1 loop (learning_spec.md section 10): add a link, stay 30 seconds, recall, dump,
// answer, results, due in 1 day, then Review, right, due in 2 days.
test('Release 1 loop: a link read for 30 seconds, recalled and answered, is due in 1 day; in Review it is back in 2 days when right, and in 10 minutes a level lower when wrong', async ({
	page,
}, testInfo) => {
	const desktop = testInfo.project.name === 'desktop'
	const { ids } = await openWithKey(page)
	await stay(page)
	await expect.poll(() => writeStatus(ids[0]!), { timeout: 15_000 }).toBe('ready')
	await proof(page, testInfo, 'loop-1-read')
	const ideas = await ideasOf(ids[0]!)
	const title = await sectionTitle(page).innerText()
	// Recall: the dump covers the first idea, its deeper question is answered right, the others with I don't know.
	await page.getByRole('button', { name: 'Recall this section' }).click()
	await page.getByLabel('What you remember').fill(ideas[0]!.answer)
	await proof(page, testInfo, 'loop-2-dump')
	await page.getByRole('button', { name: 'Done' }).click()
	await expect(page.getByText('Question 1 of 3')).toBeVisible({ timeout: 15_000 })
	for (let n = 0; n < 3; n++) {
		const { idea } = await shownIdea(page, ideas)
		if (n === 2) await proof(page, testInfo, 'loop-3-question')
		await answerShown(page, idea.id === ideas[0]!.id ? idea.answer : null, 'Think so')
	}
	const map = page.getByRole('list', { name: 'Recall map' })
	await expect(map).toBeVisible()
	const covered = ideas[0]!.id
	// The covered idea, answered right, is due in 1 day.
	await expect(map.locator(':scope > li').filter({ hasText: ideas[0]!.answer }).first()).toContainText('Back tomorrow')
	await proof(page, testInfo, 'loop-4-results')
	const afterRecall = await cardNow(covered)
	expect(afterRecall.level).toBe(2)
	expect(Math.abs(minutesUntil(afterRecall.due_at) - DAY_MINUTES)).toBeLessThanOrEqual(1)
	await makeDue(covered)

	// Home: the due count opens Review in one click.
	await page.goto('/')
	await expect(page.getByTestId('due-count')).toHaveText('1')
	await page.getByRole('link', { name: 'Review due ideas' }).click()
	await expect(page).toHaveURL('/mind/review')
	await expect(page.getByTestId('review-total')).toHaveText('1 due · about 1 min')
	await expect(page.getByText('Card 1 of 1')).toBeVisible()
	await expect(page.getByTestId('source')).toHaveText(`JavaScript execution model · ${title}`)
	// Its one stored question was asked in the recall, so Review asks its cue.
	await expect(page.getByTestId('question')).toHaveText(ideas[0]!.prompt)
	await proof(page, testInfo, 'review-question')
	await page.getByLabel('Your answer').fill(ideas[0]!.answer)
	if (desktop) {
		// Out of the box, 2 is Think so.
		await page.keyboard.press('Tab')
		await page.keyboard.press('2')
	} else await page.getByRole('button', { name: 'Think so' }).click()
	const result = page.getByTestId('result')
	await expect(result).toContainText('Right')
	await expect(result).toContainText('Back in 2 days')
	await proof(page, testInfo, 'review-right')
	const right = await cardNow(covered)
	expect(right.level).toBe(3)
	expect(Math.abs(minutesUntil(right.due_at) - 2 * DAY_MINUTES)).toBeLessThanOrEqual(1)
	if (desktop) await page.keyboard.press('Enter')
	else await page.getByRole('button', { name: 'Next' }).click()
	await expect(page.getByText('You answered 1 of 1 right.')).toBeVisible()
	await expect(page.getByRole('button', { name: 'Keep going' })).toHaveCount(0)

	// Due again, and answered wrong: back in 10 minutes, a level lower.
	await makeDue(covered)
	await page.reload()
	await page.getByLabel('Your answer').fill('Something about bananas')
	await page.getByRole('button', { name: 'Sure', exact: true }).click()
	await expect(result).toContainText('Not quite')
	await expect(result).toContainText('Back in 10 minutes')
	const wrong = await cardNow(covered)
	expect(wrong.level).toBe(2)
	expect(minutesUntil(wrong.due_at)).toBe(10)
	await proof(page, testInfo, 'review-wrong')
	await page.getByRole('button', { name: 'Next' }).click()
	await expect(page.getByRole('region', { name: 'You were sure about these' })).toContainText(ideas[0]!.answer)
	await expect(page.getByText('You answered 0 of 1 right.')).toBeVisible()
	await proof(page, testInfo, 'review-summary-sure')
	// Retry missed ideas asks it again through its cue, as practice: the schedule stays.
	await page.getByRole('button', { name: 'Retry missed ideas' }).click()
	await expect(page.getByText('Retry 1 of 1 · practice, your schedule stays as it is')).toBeVisible()
	await expect(page.getByTestId('question')).toHaveText(ideas[0]!.prompt)
	await page.getByLabel('Your answer').fill(ideas[0]!.answer)
	await page.getByRole('button', { name: 'Sure', exact: true }).click()
	await expect(result).toContainText('Right')
	await expect(result).not.toContainText('Back in')
	await proof(page, testInfo, 'review-retry')
	expect(await cardNow(covered)).toEqual(wrong)
	await page.getByRole('button', { name: 'Next' }).click()
	await page.getByRole('button', { name: 'Back to the summary' }).click()
	await page.getByRole('button', { name: 'Done' }).click()
	await expect(page).toHaveURL('/mind')
})

test('Count it as right on a wrong answer in Review schedules it as a right one, once; when the judge fails, the member checks it', async ({ page }, testInfo) => {
	const { ids } = await openWithKey(page)
	await stay(page)
	await expect.poll(() => writeStatus(ids[0]!), { timeout: 15_000 }).toBe('ready')
	const [idea, other] = await ideasOf(ids[0]!)
	// Two started cards at level 1 with their stored questions not asked yet, due now, the first one longest.
	await sql("update cards set started_at = now(), level = 1, due_at = now() - interval '2 seconds' where id = $1", [idea!.id])
	await sql("update cards set started_at = now(), level = 1, due_at = now() - interval '1 second' where id = $1", [other!.id])
	await page.goto('/mind/review')
	await expect(page.getByTestId('question')).toHaveText(/^Why does point 1 of this part matter/)
	await page.getByLabel('Your answer').fill('Something about bananas')
	await page.getByRole('button', { name: 'Sure', exact: true }).click()
	const result = page.getByTestId('result')
	await expect(result).toContainText('Not quite')
	await expect(result).toContainText('Back in 10 minutes')
	await result.getByRole('button', { name: 'Count it as right' }).click()
	await expect(result).toContainText('Counted as right')
	await expect(result).toContainText('Back tomorrow')
	await expect(result.getByRole('button', { name: 'Count it as right' })).toHaveCount(0)
	await proof(page, testInfo, 'count-it-as-right')
	const card = await cardNow(idea!.id)
	expect(card.level).toBe(2)
	expect(Math.abs(minutesUntil(card.due_at) - DAY_MINUTES)).toBeLessThanOrEqual(1)
	await page.getByRole('button', { name: 'Next' }).click()

	// The judge fails on the next answer: the member sees the idea and rates it themself.
	await expect(page.getByText('Card 2 of 2')).toBeVisible()
	await page.getByLabel('Your answer').fill('JUDGE_FAILS but I remember it')
	await page.getByRole('button', { name: 'Think so' }).click()
	await expect(page.getByRole('status')).toHaveText('Your answer couldn’t be checked just now. Check it yourself.')
	await expect(page.getByText('You wrote: JUDGE_FAILS but I remember it')).toBeVisible()
	await expect(page.getByTestId('answer')).toContainText(other!.answer)
	await proof(page, testInfo, 'self-check')
	await page.getByRole('button', { name: 'Got it' }).click()

	// Counted as right, the first is no longer a confident error.
	await expect(page.getByText('You answered 2 of 2 right.')).toBeVisible()
	expect(await sql('select ask, graded_by, rating from review_log where card_id = $1', [other!.id])).toEqual([{ ask: 'self', graded_by: 'self', rating: 'good' }])
	await expect(page.getByRole('region', { name: 'You were sure about these' })).toHaveCount(0)
})

test('Report a problem on a question in Review retires it, and the answer to it does not count', async ({ page }, testInfo) => {
	const { ids } = await openWithKey(page)
	await stay(page)
	await expect.poll(() => writeStatus(ids[0]!), { timeout: 15_000 }).toBe('ready')
	const [idea] = await ideasOf(ids[0]!)
	await sql("update cards set started_at = now(), level = 1, due_at = now() - interval '1 second' where id = $1", [idea!.id])
	const before = await cardNow(idea!.id)
	await page.goto('/mind/review')
	await page.getByLabel('Your answer').fill(idea!.answer)
	await page.getByRole('button', { name: 'Think so' }).click()
	const result = page.getByTestId('result')
	await expect(result).toContainText('Right')
	await page.getByRole('button', { name: 'Report a problem' }).click()
	const report = page.getByRole('group', { name: 'Report a problem' })
	await expect(report.getByRole('button')).toHaveText(['The answer is wrong', 'The question is unclear', 'It isn’t in the text', 'Cancel'])
	await proof(page, testInfo, 'report-reasons')
	await report.getByRole('button', { name: 'It isn’t in the text' }).click()
	await expect(page.getByRole('status')).toHaveText('Thanks. This question won’t be asked again, and this answer doesn’t count.')
	await proof(page, testInfo, 'reported')
	const [question] = await sql<{ report: string; retired_at: Date | null }>('select report, retired_at from questions where card_id = $1', [idea!.id])
	expect(question).toMatchObject({ report: 'not_in_text', retired_at: expect.any(Date) })
	expect(await sql('select mode from review_log where card_id = $1', [idea!.id])).toEqual([{ mode: 'practice' }])
	expect(await cardNow(idea!.id)).toEqual(before)
	await page.getByRole('button', { name: 'Next' }).click()
	await expect(page.getByText('That was the batch.')).toBeVisible()
	// Still due, and now asked through its cue.
	await page.reload()
	await expect(page.getByTestId('question')).toHaveText(idea!.prompt)
	await expect(page.getByRole('button', { name: 'Report a problem' })).toHaveCount(0)
})

test('Multiple choice in Review: options stored shuffled, shown after a typed guess (Guess first), graded against the key, then confident errors and the calibration line', async ({ page }, testInfo) => {
	const { readingId, ids } = await openWithKey(page)
	// Choice only, so every question the fake AI writes is multiple choice.
	await sql(
		"insert into preferences (user_id, question_style) select user_id, 'choice' from readings where id = $1 on conflict (user_id) do update set question_style = 'choice'",
		[readingId],
	)
	await stay(page)
	await expect.poll(() => writeStatus(ids[0]!), { timeout: 15_000 }).toBe('ready')
	const [idea, other] = await ideasOf(ids[0]!)
	const RIGHT = 'It holds as the text states it.'
	const reasons: Record<string, string> = {
		'It holds only on some days.': 'The text sets no such limit on when.',
		'It holds for experts alone.': 'The text says it holds for anyone.',
		'It never holds in practice.': 'The text shows it holding.',
		[RIGHT]: '',
	}
	const stored = await sql<{ card_id: string; type: string; content: { options: string[]; answerIndex: number; whyWrong: string[] } }>(
		'select card_id, type, content from questions where card_id in ($1, $2)',
		[idea!.id, other!.id],
	)
	expect(stored.map((q) => q.type)).toEqual(['mcq', 'mcq'])
	for (const { content } of stored) {
		// Shuffled in code, with the key and the reasons moved along with their options.
		expect(content.options[content.answerIndex]).toBe(RIGHT)
		content.options.forEach((o, i) => expect(content.whyWrong[i]).toBe(reasons[o]))
	}
	await sql("update cards set started_at = now(), level = 1, due_at = now() - interval '2 seconds' where id = $1", [idea!.id])
	await sql("update cards set started_at = now(), level = 1, due_at = now() - interval '1 second' where id = $1", [other!.id])

	// Guess first is on by default: the options wait until the member types a guess.
	await page.goto('/mind/review')
	await expect(page.getByRole('switch', { name: /Guess first/ })).toBeChecked()
	await expect(page.getByTestId('question')).toHaveText('Which reading of point 1 of this part holds up?')
	const options = page.getByRole('radiogroup', { name: 'Options' })
	await expect(options).toHaveCount(0)
	await expect(page.getByRole('button', { name: 'Show options' })).toBeDisabled()
	await proof(page, testInfo, 'guess-first')
	await page.getByLabel('Your answer in a few words').fill('It is never true')
	await page.getByRole('button', { name: 'Show options' }).click()
	await expect(page.getByText('Your guess: It is never true')).toBeVisible()

	// A wrong pick: the result marks it, shows the right answer, and says why each wrong option is wrong.
	await expect(options.getByRole('radio')).toHaveCount(4)
	await expect(page.getByRole('button', { name: 'Sure', exact: true })).toBeDisabled()
	await options.getByRole('radio', { name: 'It never holds in practice.' }).click()
	await proof(page, testInfo, 'mcq-ask')
	await page.getByRole('button', { name: 'Sure', exact: true }).click()
	const result = page.getByTestId('result')
	await expect(result).toContainText('Not quite')
	await expect(result).toContainText('You guessed: It is never true')
	await expect(result.getByRole('listitem').filter({ hasText: 'It never holds in practice.' })).toContainText('Your pick')
	await expect(result.getByRole('listitem').filter({ hasText: RIGHT })).toContainText('Right answer')
	for (const [option, why] of Object.entries(reasons)) if (why) await expect(result.getByRole('listitem').filter({ hasText: option })).toContainText(why)
	await expect(result).toContainText('Back in 10 minutes')
	// Checked against its key, so there is nothing to count as right.
	await expect(result.getByRole('button', { name: 'Count it as right' })).toHaveCount(0)
	await proof(page, testInfo, 'mcq-wrong')
	expect(await sql('select ask, graded_by, correct, rating, response from review_log where card_id = $1', [idea!.id])).toEqual([
		{
			ask: 'question',
			graded_by: 'code',
			correct: false,
			rating: 'again',
			response: { choice: stored.find((q) => q.card_id === idea!.id)!.content.options.indexOf('It never holds in practice.'), guess: 'It is never true' },
		},
	])
	await page.getByRole('button', { name: 'Next' }).click()

	// The right pick, by keys after the guess: its letter, then 1 for Guessing. A right guess is spaced like a hard answer.
	await expect(page.getByText('Card 2 of 2')).toBeVisible()
	await page.getByLabel('Your answer in a few words').fill('As the text says')
	await page.getByRole('button', { name: 'Show options' }).click()
	const radios = page.getByRole('radiogroup', { name: 'Options' }).getByRole('radio')
	const right = (await radios.allInnerTexts()).findIndex((t) => t.includes(RIGHT))
	await page.keyboard.press('abcd'[right]!)
	await expect(radios.nth(right)).toHaveAttribute('aria-checked', 'true')
	await page.keyboard.press('1')
	await expect(page.getByTestId('result')).toContainText('Right')
	const [log] = await sql<{ graded_by: string; rating: string; confidence: string }>('select graded_by, rating, confidence from review_log where card_id = $1', [other!.id])
	expect(log).toEqual({ graded_by: 'code', rating: 'hard', confidence: 'guessing' })
	await page.getByRole('button', { name: 'Next' }).click()

	// The batch ends with the confident error first, then how often each confidence was right.
	await expect(page.getByText('You answered 1 of 2 right.')).toBeVisible()
	await expect(page.getByRole('region', { name: 'You were sure about these' })).toContainText(idea!.answer)
	await expect(page.getByTestId('calibration')).toHaveText('Sure: 0 of 1 right · Guessing: 1 of 1')
	await proof(page, testInfo, 'calibration-results')

	// Turning Guess first off on Review turns it off in Settings → Questions too.
	await page.getByRole('switch', { name: /Guess first/ }).click()
	await expect.poll(() => sql<{ guess_first: boolean }>('select guess_first from preferences where user_id = (select user_id from readings where id = $1)', [readingId]).then((r) => r[0]!.guess_first)).toBe(false)
	await page.goto('/settings')
	await expect(page.getByRole('switch', { name: /Guess first/ })).not.toBeChecked()

	// Progress shows the same calibration over the last 12 weeks, and the Sure-but-wrong count this month.
	await page.goto('/mind/progress')
	await expect(page.getByTestId('calibration')).toHaveText('Sure: 0 of 1 right · Guessing: 1 of 1')
	await expect(page.getByTestId('sure-wrong')).toHaveText('Sure but wrong this month: 1')
	await proof(page, testInfo, 'calibration-progress')
})

test('A worked problem and a predicted output in Review: a number box with its unit and optional working, a box for the output, the right answer beside the member’s', async ({ page }, testInfo) => {
	const { readingId, ids } = await openWithKey(page)
	await stay(page)
	await expect.poll(() => writeStatus(ids[0]!), { timeout: 15_000 }).toBe('ready')
	const [idea, other] = await ideasOf(ids[0]!)
	// Swap the written questions for one of each exact kind, so the test knows what is asked.
	await sql('update questions set retired_at = now() where card_id in ($1, $2)', [idea!.id, other!.id])
	const add = (cardId: string, type: string, content: Record<string, unknown>) =>
		sql("insert into questions (user_id, card_id, type, level, content) select user_id, $2, $3, 'apply', $4 from readings where id = $1", [readingId, cardId, type, content])
	await add(idea!.id, 'worked_problem', {
		prompt: 'Review gaps of 1, 3 and 9 days each triple. On which day is the next review?',
		answer: 27,
		unit: 'days',
		tolerance: 0,
		solution: 'Each gap is three times the last, so the gap after day 9 is 18 days, and 9 + 18 gives day 27.',
		steps: ['triple the previous interval', 'add the interval to the previous review'],
	})
	await add(other!.id, 'predict_output', {
		prompt: 'What does this print?',
		code: 'let gap = 1\nfor (const day of [1, 2, 3]) {\n  gap = gap * 2\n  console.log(day, gap)\n}',
		output: '1 2\n2 4\n3 8',
		explanation: 'The gap doubles once a day, starting from 1, so it is 2, 4, then 8.',
	})
	await sql("update cards set started_at = now(), level = 1, due_at = now() - interval '2 seconds' where id = $1", [idea!.id])
	await sql("update cards set started_at = now(), level = 1, due_at = now() - interval '1 second' where id = $1", [other!.id])

	// A worked problem: the number in its own box, with its unit, and room for the working.
	await page.goto('/mind/review')
	await expect(page.getByTestId('question')).toHaveText('Review gaps of 1, 3 and 9 days each triple. On which day is the next review?')
	await expect(page.getByText('days', { exact: true })).toBeVisible()
	const answerBox = page.getByLabel('Your answer', { exact: true })
	// A number in words is a slip of format, not of knowledge: it is caught before it counts.
	await answerBox.fill('twenty-seven')
	await expect(page.getByText('Write it as a number, such as 27 or 0.5.')).toBeVisible()
	await expect(page.getByRole('button', { name: 'Sure', exact: true })).toBeDisabled()
	await proof(page, testInfo, 'worked-unreadable')
	// A slip in the last step: the working was right until the addition.
	await answerBox.fill('28')
	await expect(page.getByText('Write it as a number, such as 27 or 0.5.')).toHaveCount(0)
	await page.getByLabel('Your working').fill('Triple the previous interval to get 18, then add the interval to the previous review on day 9: 9 + 18 = 28.')
	await proof(page, testInfo, 'worked-ask')
	await page.getByRole('button', { name: 'Sure', exact: true }).click()
	const result = page.getByTestId('result')
	// The right answer stands beside the member's, and the working is marked against the key steps.
	await expect(result).toContainText('Not quite')
	await expect(result.getByRole('definition').first()).toHaveText('27 days')
	await expect(result.getByRole('definition').nth(1)).toHaveText('28')
	await expect(result).toContainText('Worked solution')
	await expect(result).toContainText('triple the previous interval')
	await expect(result.getByRole('button', { name: 'Count it as right' })).toBeVisible()
	await proof(page, testInfo, 'worked-wrong')
	expect(await sql('select graded_by, correct, response from review_log where card_id = $1', [idea!.id])).toEqual([
		{ graded_by: 'ai', correct: false, response: { value: '28', working: 'Triple the previous interval to get 18, then add the interval to the previous review on day 9: 9 + 18 = 28.' } },
	])
	await page.getByRole('button', { name: 'Next' }).click()

	// A predicted output: the code, and a box for exactly what it prints. Spacing does not count.
	await expect(page.getByTestId('question')).toHaveText('What does this print?')
	await expect(page.getByText('console.log(day, gap)')).toBeVisible()
	await page.getByLabel('What it prints').fill('1 2\n2  4\n3 8')
	await proof(page, testInfo, 'output-ask')
	await page.getByRole('button', { name: 'Think so' }).click()
	await expect(result).toContainText('Right')
	await expect(result).toContainText('Why it prints that')
	await expect(result).toContainText('The gap doubles once a day')
	await expect(result.getByRole('button', { name: 'Count it as right' })).toHaveCount(0)
	await proof(page, testInfo, 'output-right')
	expect(await sql('select graded_by, correct from review_log where card_id = $1', [other!.id])).toEqual([{ graded_by: 'code', correct: true }])
})

test('Order the steps in Review: tap them first to last, take one back or start over, then see the right order with where each step went, Nearly for a close order', async ({ page }, testInfo) => {
	const { readingId, ids } = await openWithKey(page)
	await stay(page)
	await expect.poll(() => writeStatus(ids[0]!), { timeout: 15_000 }).toBe('ready')
	const [idea, other] = await ideasOf(ids[0]!)
	await sql('update questions set retired_at = now() where card_id in ($1, $2)', [idea!.id, other!.id])
	const steps = ['Wait a day or more', 'Recall it without notes', 'Check it against the text', 'Mark what you missed']
	const add = (cardId: string, prompt: string) =>
		sql("insert into questions (user_id, card_id, type, level, content) select user_id, $2, 'order_steps', 'explain', $3 from readings where id = $1", [
			readingId,
			cardId,
			{ prompt, steps, shown: [2, 0, 3, 1], explanation: 'Recall needs a gap before it to be effortful, and a check after it to fix what slipped.' },
		])
	await add(idea!.id, 'Put a spaced self-test in order.')
	await add(other!.id, 'Put a spaced self-test of a new chapter in order.')
	await sql("update cards set started_at = now(), level = 1, due_at = now() - interval '2 seconds' where id = $1", [idea!.id])
	await sql("update cards set started_at = now(), level = 1, due_at = now() - interval '1 second' where id = $1", [other!.id])

	// The steps show shuffled; no typed guess first, the steps are the question.
	await page.goto('/mind/review')
	await expect(page.getByTestId('question')).toHaveText('Put a spaced self-test in order.')
	const toPlace = page.getByRole('group', { name: 'Steps to place' })
	await expect(toPlace.getByRole('button')).toHaveText(['ACheck it against the text', 'BWait a day or more', 'CMark what you missed', 'DRecall it without notes'])
	await expect(page.getByLabel('Your answer in a few words')).toHaveCount(0)
	const sure = page.getByRole('button', { name: 'Sure', exact: true })
	await expect(sure).toBeDisabled()

	// Tap to place; a placed step taps back; Start over clears the order.
	await toPlace.getByRole('button', { name: 'Check it against the text' }).click()
	await page.getByRole('button', { name: 'Take back: Check it against the text' }).click()
	await expect(page.getByRole('list', { name: 'Your order' })).toHaveCount(0)
	await toPlace.getByRole('button', { name: 'Wait a day or more' }).click()
	await page.getByRole('button', { name: 'Start over' }).click()
	await expect(toPlace.getByRole('button')).toHaveCount(4)
	// Close but not right: the check and the recall swapped.
	for (const step of ['Wait a day or more', 'Check it against the text', 'Recall it without notes']) await toPlace.getByRole('button', { name: step }).click()
	await expect(sure).toBeDisabled()
	await toPlace.getByRole('button', { name: 'Mark what you missed' }).click()
	await expect(page.getByRole('list', { name: 'Your order' }).getByRole('listitem')).toHaveText(['1Wait a day or more', '2Check it against the text', '3Recall it without notes', '4Mark what you missed'])
	await proof(page, testInfo, 'order-ask')
	await sure.click()
	const result = page.getByTestId('result')
	await expect(result).toContainText('Nearly')
	await expect(result).toContainText('5 of 6 pairs of steps in the right order')
	const right = result.getByRole('list', { name: 'Right order' }).getByRole('listitem')
	await expect(right.nth(1)).toContainText('Recall it without notes')
	await expect(right.nth(1)).toContainText('You put it 3rd')
	await expect(right.nth(2)).toContainText('You put it 2nd')
	await expect(right.nth(0)).not.toContainText('You put it')
	await expect(result).toContainText('Why this order')
	await expect(result.getByRole('button', { name: 'Count it as right' })).toHaveCount(0)
	await proof(page, testInfo, 'order-nearly')
	expect(await sql('select graded_by, rating, correct from review_log where card_id = $1', [idea!.id])).toEqual([{ graded_by: 'code', rating: 'hard', correct: false }])
	await page.getByRole('button', { name: 'Next' }).click()

	// By keys: each step's letter places it (B, D, A, C is the right order), then 2 for Think so.
	await expect(page.getByTestId('question')).toHaveText('Put a spaced self-test of a new chapter in order.')
	for (const key of 'bdac') await page.keyboard.press(key)
	await page.keyboard.press('2')
	await expect(result).toContainText('Right')
	await expect(result).not.toContainText('You put it')
	await proof(page, testInfo, 'order-right')
	expect(await sql('select rating, correct, confidence from review_log where card_id = $1', [other!.id])).toEqual([{ rating: 'good', correct: true, confidence: 'think_so' }])
})

test('Settings → Questions sets how many and which kinds; Rewrite questions writes new ones for the same ideas and keeps every answer and schedule', async ({ page }, testInfo) => {
	const { readingId, ids } = await openWithKey(page)
	await stay(page)
	await expect.poll(() => writeStatus(ids[0]!), { timeout: 15_000 }).toBe('ready')
	const ideas = await ideasOf(ids[0]!)

	// Settings → Questions: Thorough, Written only, and no second check. Each click saves.
	await page.goto('/settings')
	const questions = page.getByRole('group', { name: 'How many' })
	await expect(questions.getByRole('radio', { name: 'Standard' })).toBeChecked()
	await expect(page.getByRole('group', { name: 'Kinds' }).getByRole('radio', { name: 'Mixed' })).toBeChecked()
	await expect(page.getByRole('checkbox', { name: /Check questions twice/ })).toBeChecked()
	await page.getByText('Thorough', { exact: true }).click()
	await expect(page.getByText('Two questions on each key idea: one on why, one applying it.')).toBeVisible()
	await page.getByText('Written', { exact: true }).click()
	await page.getByRole('checkbox', { name: /Check questions twice/ }).uncheck()
	const prefsOf = () =>
		sql<{ question_amount: string; question_style: string; quality_check: boolean }>(
			'select question_amount, question_style, quality_check from preferences where user_id = (select user_id from readings where id = $1)',
			[readingId],
		).then((r) => r[0])
	await expect.poll(prefsOf).toEqual({ question_amount: 'thorough', question_style: 'written', quality_check: false })
	await proof(page, testInfo, 'settings-questions')

	// One idea answered in Review, so it has a schedule and a log row to keep.
	await sql("update cards set started_at = now(), level = 1, due_at = now() - interval '1 second' where id = $1", [ideas[0]!.id])
	await page.goto('/mind/review')
	await page.getByLabel('Your answer').fill(ideas[0]!.answer)
	await page.getByRole('button', { name: 'Sure', exact: true }).click()
	await expect(page.getByTestId('result')).toContainText('Right')
	const logBefore = await sql('select id, card_id, question_id, rating from review_log where card_id = any($1) order by id', [ideas.map((i) => i.id)])
	expect(logBefore).toHaveLength(1)
	const oldQuestions = await sql<{ id: string }>('select id from questions where section_id = $1', [ids[0]])
	const cardsBefore = await ideasOf(ids[0]!)

	// The section menu: Rewrite questions only, since an idea is in review.
	await page.goto(`/mind/read/${readingId}`)
	await page.getByRole('button', { name: 'Section menu' }).click()
	const menu = page.getByRole('menu')
	await expect(menu.getByRole('menuitem')).toHaveCount(1)
	await proof(page, testInfo, 'section-menu')
	await page.keyboard.press('Escape')
	await expect(menu).toHaveCount(0)
	await page.getByRole('button', { name: 'Section menu' }).click()
	await menu.getByRole('menuitem', { name: /Rewrite questions/ }).click()
	await expect(page.getByText('Rewriting questions for this section…')).toBeVisible()
	await expect(page.getByRole('status').filter({ hasText: 'New questions are ready. Your answers so far are kept.' })).toBeVisible({ timeout: 15_000 })

	// Old questions retired, not deleted; two new written ones per idea; every answer and schedule as it was.
	const after = await sql<{ id: string; card_id: string; type: string; retired_at: Date | null }>('select id, card_id, type, retired_at from questions where section_id = $1', [ids[0]])
	expect(after.filter((q) => oldQuestions.some((o) => o.id === q.id)).every((q) => q.retired_at)).toBe(true)
	const fresh = after.filter((q) => !q.retired_at)
	for (const idea of ideas) expect(fresh.filter((q) => q.card_id === idea.id)).toHaveLength(2)
	expect(fresh.every((q) => q.type === 'short_answer')).toBe(true)
	expect(await sql('select id, card_id, question_id, rating from review_log where card_id = any($1) order by id', [ideas.map((i) => i.id)])).toEqual(logBefore)
	expect(await ideasOf(ids[0]!)).toEqual(cardsBefore)
	expect(cardsBefore[0]!.started_at).not.toBeNull()

	// In Review, the answered idea is asked a new question when it comes back.
	await sql("update cards set due_at = now() - interval '1 second' where id = $1", [ideas[0]!.id])
	await page.goto('/mind/review')
	await expect(page.getByTestId('question')).toHaveText(/^(How would idea \d+ of this part change what a newcomer does next|What would go wrong for a beginner who ignored idea \d+ of this part)\?$/)
})

test('Review without a key: self-rated cards, 20 at a time with Keep going, filters, and answer keys that never switch worlds', async ({ page }, testInfo) => {
	const desktop = testInfo.project.name === 'desktop'
	const email = await joinAs(page)
	for (let i = 1; i <= 21; i++) {
		const res = await api(page, 'review/add', { id: crypto.randomUUID(), kind: 'lesson', prompt: `Lesson ${i}: what did it teach?`, answer: `The answer to lesson ${i}.` })
		expect(res.ok()).toBe(true)
	}
	await page.goto('/mind')
	await expect(page.getByTestId('mind-due')).toHaveText('21')
	await expect(page.getByText('about 9 min · Review due ideas')).toBeVisible()
	await page.getByRole('link', { name: 'Review due ideas' }).click()
	await expect(page.getByTestId('review-total')).toHaveText('21 due · about 9 min')
	await page.getByRole('button', { name: 'Readings' }).click()
	await expect(page.getByText('Nothing is due right now. Ideas come back here when it is time to recall them.')).toBeVisible()
	await page.getByRole('button', { name: 'Lessons' }).click()
	await expect(page.getByRole('button', { name: 'Lessons' })).toHaveAttribute('aria-pressed', 'true')
	await expect(page.getByText('Card 1 of 20')).toBeVisible()
	const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
	await expect(page.getByTestId('source')).toHaveText(`Lesson · ${today}`)
	await expect(page.getByTestId('question')).toHaveText('Lesson 1: what did it teach?')
	await expect(page.getByTestId('answer')).toHaveCount(0)
	await proof(page, testInfo, 'self-rated')
	if (desktop) {
		await expect(page.getByRole('button', { name: 'Show answer' })).toBeFocused()
		await page.keyboard.press('Space')
		await expect(page.getByTestId('answer')).toContainText('The answer to lesson 1.')
		await proof(page, testInfo, 'self-rated-shown')
		// Here 1 is Forgot, not a jump to Home.
		await page.keyboard.press('1')
		await expect(page.getByText('Card 2 of 20')).toBeVisible()
		expect(new URL(page.url()).pathname).toBe('/mind/review')
	} else {
		await page.getByRole('button', { name: 'Show answer' }).click()
		await expect(page.getByTestId('answer')).toContainText('The answer to lesson 1.')
		await proof(page, testInfo, 'self-rated-shown')
		await page.getByRole('button', { name: 'Forgot' }).click()
	}
	for (let n = 2; n <= 20; n++) {
		await expect(page.getByText(`Card ${n} of 20`)).toBeVisible()
		await page.getByRole('button', { name: 'Show answer' }).click()
		await page.getByRole('button', { name: 'Got it' }).click()
	}
	await expect(page.getByText('You answered 19 of 20 right.')).toBeVisible()
	// Self-rated cards have nothing to retry.
	await expect(page.getByRole('button', { name: 'Retry missed ideas' })).toHaveCount(0)
	await proof(page, testInfo, 'batch-summary')
	await page.getByRole('button', { name: 'Keep going' }).click()
	await expect(page.getByText('Card 1 of 1')).toBeVisible()
	await expect(page.getByTestId('question')).toHaveText('Lesson 21: what did it teach?')
	await page.getByRole('button', { name: 'Show answer' }).click()
	await page.getByRole('button', { name: 'Got it' }).click()
	await expect(page.getByText('You answered 1 of 1 right.')).toBeVisible()
	await expect(page.getByRole('button', { name: 'Keep going' })).toHaveCount(0)

	const log = await sql<{ prompt: string; ask: string; rating: string; graded_by: string }>(
		"select c.prompt, l.ask, l.rating, l.graded_by from review_log l join cards c on c.id = l.card_id where l.user_id = (select id from users where email = $1) order by l.id",
		[email],
	)
	expect(log).toHaveLength(21)
	expect(log[0]).toEqual({ prompt: 'Lesson 1: what did it teach?', ask: 'self', rating: 'again', graded_by: 'self' })
	expect(log.slice(1).every((r) => r.rating === 'good')).toBe(true)
	await page.getByRole('button', { name: 'Done' }).click()
	await expect(page).toHaveURL('/mind')
	await expect(page.getByTestId('mind-due')).toHaveText('0')
})

test('without a key, the sample reading runs the whole loop: dump, Compare with the text, own marks, self-checked answers, results, then Review', async ({ page }, testInfo) => {
	await joinAs(page, 'Rohit', { sample: true })
	await page.goto('/mind')
	const sample = page.getByTestId('reading').filter({ hasText: 'How to remember what you read' })
	await expect(sample).toContainText('3 sections')
	await expect(page.getByText('Add your own AI key in Settings to get questions on your readings.')).toBeVisible()
	await proof(page, testInfo, 'sample-on-mind')
	// It is added once: another visit adds no second copy.
	await page.reload()
	await expect(page.getByTestId('reading')).toHaveCount(1)

	await sample.getByRole('link').first().click()
	await expect(sectionTitle(page)).toHaveText('Rereading feels like learning')
	const readingId = new URL(page.url()).pathname.split('/').at(-1)!
	const [section] = await sectionIds(readingId)
	const ideas = await ideasOf(section!)
	expect(ideas.map((i) => i.started_at)).toEqual([null, null, null])
	await page.getByRole('button', { name: 'Recall this section' }).click()
	await page.getByLabel('What you remember').fill('Rereading feels like learning because familiar text is easy, but that is recognition.')
	await page.getByRole('button', { name: 'Done' }).click()
	const attemptId = attemptIdOf(page)

	// No key: the member compares the dump with the text and marks each idea, Missed until changed.
	await expect(page.getByRole('heading', { name: 'Compare with the text' })).toBeVisible({ timeout: 15_000 })
	await expect(page.getByRole('region', { name: 'What you wrote' })).toContainText('familiar text is easy, but that is recognition')
	await expect(page.getByRole('region', { name: 'The text' })).toContainText('Familiar text is easy to process')
	const marks = page.getByRole('list', { name: 'Key ideas' }).locator(':scope > li')
	await expect(marks).toHaveCount(3)
	for (let k = 0; k < 3; k++) await expect(marks.nth(k).getByRole('radio', { name: 'Missed' })).toHaveAttribute('aria-checked', 'true')
	await marks.nth(0).getByRole('radio', { name: 'Got it' }).click()
	await marks.nth(2).getByRole('radio', { name: 'Partly' }).click()
	await proof(page, testInfo, 'compare-with-the-text')
	await page.getByRole('button', { name: 'Go on to the questions' }).click()

	// The missed idea first, through its cue, checked against the idea itself.
	await expect(page.getByText('Question 1 of 3')).toBeVisible()
	await expect(page.getByTestId('question')).toHaveText('Which kind of remembering does a meeting or an exam ask of you?')
	await page.getByLabel('Your answer').fill('Recall, not recognition.')
	await page.getByRole('button', { name: 'Sure', exact: true }).click()
	const checklist = page.getByTestId('checklist')
	await expect(checklist.getByRole('group', { name: 'Did your answer say this?' })).toBeVisible()
	await expect(checklist).not.toContainText('Model answer')
	await proof(page, testInfo, 'self-check-cue')
	await checklist.getByRole('checkbox', { name: 'Recognising something is not the same as recalling it, and everyday life asks for recall.' }).check()
	await page.getByRole('button', { name: 'Done' }).click()

	// The vague idea: its lowest stored question, with the model answer and two points to tick. One is made.
	await expect(page.getByText('Question 2 of 3')).toBeVisible()
	await expect(page.getByTestId('question')).toHaveText('Why does trying to recall a text, which feels slow and full of gaps, beat rereading it?')
	await page.getByLabel('Your answer').fill('Recalling makes the memory stronger.')
	await page.getByRole('button', { name: 'Think so' }).click()
	await expect(checklist).toContainText('Model answer')
	await expect(checklist.getByRole('checkbox')).toHaveCount(2)
	await checklist.getByRole('checkbox', { name: 'Retrieving an idea strengthens the memory of it' }).check()
	await proof(page, testInfo, 'self-check-points')
	await page.getByRole('button', { name: 'Done' }).click()

	// The covered idea: its question, both points made.
	await expect(page.getByText('Question 3 of 3')).toBeVisible()
	await expect(page.getByTestId('question')).toHaveText('Why can a chapter you have read twice still be gone a week later, even though it felt familiar?')
	await page.getByLabel('Your answer').fill('It felt easy and familiar, but I only recognised it; I could not recall it.')
	await page.getByRole('button', { name: 'Think so' }).click()
	await expect(checklist.getByRole('checkbox')).toHaveCount(2)
	for (const box of await checklist.getByRole('checkbox').all()) await box.check()
	await page.getByRole('button', { name: 'Done' }).click()

	const map = page.getByRole('list', { name: 'Recall map' })
	await expect(map.locator(':scope > li')).toHaveCount(3)
	await expect(page.getByText('You brought back 1 of 3 key ideas, and answered 2 of 3 questions right.')).toBeVisible()
	await expect(map.locator(':scope > li').nth(2)).toContainText('Vague')
	await expect(map.locator(':scope > li').nth(2)).toContainText('Not quite')
	await expect(map.locator(':scope > li').nth(2)).toContainText('MissedThe effort is a desirable difficulty, not a sign of failure')
	await proof(page, testInfo, 'sample-results')
	const [attempt] = await sql<{ graded_by: string; results: { status: string }[] }>('select graded_by, results from recall_attempts where id = $1', [attemptId])
	expect(attempt).toEqual({ graded_by: 'self', results: [expect.objectContaining({ status: 'covered' }), expect.objectContaining({ status: 'missing' }), expect.objectContaining({ status: 'vague' })] })
	expect(await sql('select ask, correct from review_log where attempt_id = $1 and graded_by = $2 order by reviewed_at', [attemptId, 'self'])).toEqual([
		{ ask: 'cue', correct: true },
		{ ask: 'question', correct: false },
		{ ask: 'question', correct: true },
	])
	const covered = ideas[0]!.id
	expect(Math.abs(minutesUntil((await cardNow(covered)).due_at) - DAY_MINUTES)).toBeLessThanOrEqual(1)

	// A day later, Review brings the covered idea back as a self-rated card; right puts it 2 days out.
	await makeDue(covered)
	await page.goto('/mind/review')
	await expect(page.getByText('Card 1 of 1')).toBeVisible()
	await expect(page.getByTestId('source')).toHaveText('How to remember what you read · Rereading feels like learning')
	await page.getByRole('button', { name: 'Show answer' }).click()
	await expect(page.getByTestId('answer')).toContainText(ideas[0]!.answer)
	await proof(page, testInfo, 'sample-review')
	await page.getByRole('button', { name: 'Got it' }).click()
	await expect(page.getByText('You answered 1 of 1 right.')).toBeVisible()
	expect(Math.abs(minutesUntil((await cardNow(covered)).due_at) - 2 * DAY_MINUTES)).toBeLessThanOrEqual(1)
})

test('without a key, a reading with no key ideas can only be compared with the text, and Done goes on reading', async ({ page }) => {
	await joinAs(page)
	await page.goto('/mind')
	await addLink(page, `${FAKE_SITE}/articles/execution-model`)
	const reading = page.getByTestId('reading').first()
	await expect(reading.getByText(/sections/)).toBeVisible({ timeout: 15_000 })
	await reading.getByRole('link').first().click()
	const first = await sectionTitle(page).innerText()
	await page.getByRole('button', { name: 'Recall this section' }).click()
	await page.getByLabel('What you remember').fill('Something about the event loop.')
	await page.getByRole('button', { name: 'Done' }).click()
	await expect(page.getByRole('heading', { name: 'Compare with the text' })).toBeVisible({ timeout: 15_000 })
	await expect(page.getByText('There are no key ideas to mark in this section. Add your own AI key in Settings to have them written.')).toBeVisible()
	await expect(page.getByRole('region', { name: 'The text' }).getByRole('heading', { name: first })).toBeVisible()
	await expect(page.getByRole('list', { name: 'Key ideas' })).toHaveCount(0)
	await page.getByRole('button', { name: 'Done' }).click()
	await expect(page).toHaveURL(/\/mind\/read\//)
	await expect(sectionTitle(page)).not.toHaveText(first)
})

test('Review opens with the idea most likely forgotten, not the one due longest', async ({ page }, testInfo) => {
	await joinAs(page)
	const add = async (prompt: string) => {
		const id = crypto.randomUUID()
		expect((await api(page, 'review/add', { id, kind: 'lesson', prompt, answer: 'An answer.' })).ok()).toBe(true)
		return id
	}
	const strong = await add('Anchor high in salary talks: why?')
	const weak = await add('Rest days count: why?')
	// Both last reviewed 10 days ago. The strong one has been due for 5 days, the weak one for 1,
	// but the weak one is much more likely forgotten by now (about 76% against 97%).
	await graduate(strong, 50, 10, 5)
	await graduate(weak, 2, 10, 1)

	await page.goto('/mind/review')
	await expect(page.getByText('Card 1 of 2')).toBeVisible()
	await expect(page.getByTestId('question')).toHaveText('Rest days count: why?')
	await proof(page, testInfo, 'review-weakest-first')
	await page.getByRole('button', { name: 'Show answer' }).click()
	await page.getByRole('button', { name: 'Got it' }).click()
	await expect(page.getByText('Card 2 of 2')).toBeVisible()
	await expect(page.getByTestId('question')).toHaveText('Anchor high in salary talks: why?')
})

test('Progress counts recall at review only from 20 reviews, Fading brings an idea back with Review now, and Home shows the 30-day recall', async ({ page }, testInfo) => {
	await joinAs(page)
	let lessons = 0
	/** Adds lessons already past the steps and due, answered last 10 days ago, then answers each in Review. */
	const answered = async (ratings: ('good' | 'again')[]) => {
		const ids: string[] = []
		for (const rating of ratings) {
			const id = crypto.randomUUID()
			expect((await api(page, 'review/add', { id, kind: 'lesson', prompt: `Lesson ${++lessons}: what did it teach?`, answer: 'An answer.' })).ok()).toBe(true)
			await graduate(id, 2, 10, 1)
			expect((await api(page, 'review/answer', { answerId: crypto.randomUUID(), cardId: id, mode: 'review', ask: 'self', rating })).ok()).toBe(true)
			ids.push(id)
		}
		return ids
	}
	const three = await answered(['good', 'good', 'again'])

	await page.goto('/mind')
	await page.getByRole('link', { name: 'Progress' }).click()
	await expect(page.getByRole('heading', { name: 'Progress', level: 1 })).toBeVisible()
	await expect(page.getByTestId('recall-at-review')).toHaveText('Not enough reviews yet (3 of 20)')
	await expect(page.getByTestId('ideas-known')).toHaveText('3')
	await expect(page.getByTestId('ideas-new')).toHaveText('0')
	// Each answer came 10 days after the one before.
	await expect(page.getByTestId('recall-by-gap').getByRole('listitem').filter({ hasText: '4 days to 4 weeks' })).toContainText('2 of 3 right')
	await proof(page, testInfo, 'progress-not-enough')

	// Weeks later, still not due: on Mind under Fading, the weakest first; Review now asks it at once.
	await graduate(three[0]!, 40, 20, -10)
	await graduate(three[1]!, 25, 20, -2)
	await graduate(three[2]!, 60, 20, -30)
	await page.goto('/mind')
	const fading = page.getByRole('region', { name: 'Fading' })
	await expect(fading.getByRole('listitem')).toHaveCount(3)
	await expect(fading.getByRole('listitem').locator('p:first-child')).toHaveText(['Lesson 2: what did it teach?', 'Lesson 1: what did it teach?', 'Lesson 3: what did it teach?'])
	await proof(page, testInfo, 'mind-fading')
	const first = 'Lesson 2: what did it teach?'
	await fading.getByRole('button', { name: 'Review now' }).first().click()
	await expect(page).toHaveURL(/\/mind\/review\?first=/)
	await expect(page.getByText('Card 1 of 1')).toBeVisible()
	await expect(page.getByTestId('question')).toHaveText(first)

	await page.goto('/')
	await expect(page.getByTestId('due-count')).toHaveText('1')
	await expect(page.getByTestId('recall-30d')).toHaveCount(0)

	// 17 more: 12 right, so 14 of 20.
	await answered([...Array(12).fill('good'), ...Array(5).fill('again')])
	await page.reload()
	await expect(page.getByTestId('recall-30d')).toHaveText('Recalled 70% at review, last 30 days')
	await proof(page, testInfo, 'home-recall')
	await page.goto('/mind/progress')
	await expect(page.getByTestId('recall-at-review')).toHaveText('70% of 20 right')
	await proof(page, testInfo, 'progress')
})

/** An EPUB whose chapter one has four parts, each with three plain sentences the fake AI makes key ideas of. */
const chapterBook = () =>
	Buffer.from(
		testEpub({
			'OEBPS/text/a.xhtml': `<html><body><h2 id="c1">Chapter One</h2>
				<p>Memory researchers study how people keep what they learn. Forgetting begins within minutes of finishing a lesson. Ebbinghaus measured forgetting with lists of nonsense syllables.</p>
				<h3>Sleep</h3><p>Deep sleep moves fresh memories into lasting storage. A tired brain absorbs new material poorly. Students who sleep after studying remember considerably more.</p>
				<h3>Spacing</h3><p>Spaced practice beats cramming for durable retention. Each delayed review strengthens the memory trace further. Gaps between sessions should grow as knowledge firms up.</p>
				<h3>Testing</h3><p>Retrieval practice teaches more than rereading does. Quizzing yourself reveals gaps that rereading hides. Effortful recall builds stronger connections than recognition.</p>
				<h2 id="c2">Chapter Two</h2><p>The second chapter is short and stands on its own here.</p></body></html>`,
		}),
	)
const SLEEP = ['Deep sleep moves fresh memories into lasting storage.', 'A tired brain absorbs new material poorly.', 'Students who sleep after studying remember considerably more.']

test('Recall chapter at the end of an EPUB chapter is graded against every key idea in it, asks at most 10 questions, missed first, and starts every idea', async ({ page }, testInfo) => {
	const email = await joinAs(page)
	expect((await api(page, 'ai/saveKey', { provider: 'anthropic', apiKey: GOOD_ANTHROPIC_KEY })).ok()).toBe(true)
	await page.goto('/mind')
	await page.getByLabel('EPUB or PDF file').setInputFiles({ name: 'Memory.epub', mimeType: 'application/epub+zip', buffer: chapterBook() })
	await page.getByTestId('reading').getByRole('link', { name: /Test Book/ }).click({ timeout: 30_000 })
	const contents = page.getByRole('navigation', { name: 'Contents' })
	const open = async (name: string) => {
		if (testInfo.project.name === 'phone') await page.getByRole('button', { name: /^Contents/ }).click()
		await contents.getByRole('button', { name, exact: true }).click()
		await expect(page.getByRole('heading', { level: 2, name })).toBeVisible()
	}

	// Inside the chapter, only the section can be recalled; at its last part, the whole chapter too.
	await open('Sleep')
	await expect(page.getByRole('button', { name: 'Recall this section' })).toBeVisible()
	await expect(page.getByRole('button', { name: 'Recall chapter' })).toHaveCount(0)
	await open('Testing')
	const recall = page.getByRole('button', { name: 'Recall chapter' })
	await recall.scrollIntoViewIfNeeded()
	await proof(page, testInfo, 'recall-chapter-card')
	await recall.click()
	await expect(page.getByRole('heading', { level: 1, name: 'Chapter One: the whole chapter' })).toBeVisible()
	await page.getByLabel('What you remember').fill(SLEEP.join(' '))
	await page.getByRole('button', { name: 'Done' }).click()

	// Twelve key ideas; nine missed come first, through their cues, then one covered one: ten in all.
	await expect(page.getByText('Question 1 of 10')).toBeVisible({ timeout: 20_000 })
	await proof(page, testInfo, 'recall-chapter-question')
	const [user] = await sql<{ id: string }>('select id from users where email = $1', [email])
	const ideas = await sql<IdeaRow & { section: string }>(
		`select c.id, c.answer, c.prompt, c.level, c.due_at, c.started_at, s.title as section from cards c join sections s on s.id = c.section_id
		 where c.user_id = $1 and c.origin = 'ai' order by s.position, c.position`,
		[user!.id],
	)
	expect(ideas.map((i) => i.section)).toEqual(['Chapter One', 'Chapter One', 'Chapter One', 'Sleep', 'Sleep', 'Sleep', 'Spacing', 'Spacing', 'Spacing', 'Testing', 'Testing', 'Testing'])
	// The chapter's four sections were written in one call, not four.
	expect(await sql("select 1 from ai_calls where user_id = $1 and purpose = 'write-section'", [user!.id])).toHaveLength(1)
	for (let k = 1; k <= 9; k++) {
		await expect(page.getByText(`Question ${k} of 10`)).toBeVisible()
		const text = await page.getByTestId('question').innerText()
		expect(text, 'a missed idea is asked its cue').toMatch(/^Which point number/)
		// Each part's cues read the same here, so the next question is told by its number.
		await page.getByRole('button', { name: 'I don’t know' }).click()
		await expect(page.getByText(`Question ${k + 1} of 10`)).toBeVisible({ timeout: 15_000 })
	}
	await expect(page.getByText('Question 10 of 10')).toBeVisible()
	await expect(page.getByTestId('question')).toHaveText(/^Why does point \d of this part matter/)
	const n = Number((await page.getByTestId('question').innerText()).match(/point (\d)/)![1])
	await answerShown(page, SLEEP[n - 1]!, 'Sure')

	// The results list every idea in the chapter.
	const map = page.getByRole('list', { name: 'Recall map' })
	await expect(map.locator(':scope > li')).toHaveCount(12)
	for (const idea of ideas) await expect(map).toContainText(idea.answer)
	await expect(page.getByText('You brought back 3 of 12 key ideas, and answered 1 of 10 questions right.')).toBeVisible()
	await proof(page, testInfo, 'recall-chapter-results')

	// Every idea started; the two covered ones not asked start from the dump and are back in a day.
	const after = await sql<IdeaRow>('select id, answer, prompt, level, due_at, started_at from cards where id = any($1)', [ideas.map((i) => i.id)])
	expect(after.every((i) => i.started_at)).toBe(true)
	const unasked = SLEEP.filter((_, k) => k !== n - 1).map((s) => after.find((i) => i.answer === s)!)
	for (const idea of unasked) expect(Math.abs(minutesUntil(idea.due_at) - DAY_MINUTES)).toBeLessThanOrEqual(1)
	const attemptId = attemptIdOf(page)
	const log = await recallLog(attemptId)
	expect(log).toHaveLength(12)
	expect(log.filter((l) => l.ask === 'self').map((l) => [l.card_id, l.rating, l.mode])).toEqual(
		expect.arrayContaining(unasked.map((i) => [i.id, 'good', 'recall'])),
	)
})

/** A pasted reading of two parts, 600 words in all. */
const twoParts = () => {
	const words = (n: number, w: string) => Array.from({ length: n }, (_, i) => `${w}${i}`).join(' ')
	return `## Practice\n\n${words(300, 'practice')}.\n\n## Feedback\n\n${words(300, 'feedback')}.`
}

test('Finish by sets a pace on the tile; Finished logs the reading as a milestone whose key lessons become cards, and Undo takes both back', async ({ page }, testInfo) => {
	const email = await joinAs(page)
	const id = crypto.randomUUID()
	expect((await api(page, 'readings/addText', { id, text: twoParts(), title: 'Peak' })).ok()).toBe(true)
	await page.goto('/mind')
	const tile = page.getByTestId('reading').filter({ hasText: 'Peak' })

	// A goal a week from today (8 days, today included): 600 words = 2 pages, so 1 a day.
	const goal = new Date(Date.now() + 7 * DAY_MINUTES * 60_000).toISOString().slice(0, 10)
	await tile.getByRole('button', { name: 'Finish by' }).click()
	await tile.getByLabel('Finish by').fill(goal)
	const label = new Date(`${goal}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
	await expect(tile.getByTestId('goal')).toHaveText(`0% · about 1 page a day to finish by ${label}`)
	await proof(page, testInfo, 'tile-goal')
	// A goal day already over says so, and nothing more.
	await sql("update readings set goal_by = (now() at time zone 'utc')::date - 1 where id = $1", [id])
	await page.reload()
	await expect(tile.getByTestId('goal')).toHaveText('0% · Goal date passed')

	// Finished works from any section, without reading them all, and opens the last one.
	await tile.getByRole('link', { name: /Peak/ }).click()
	await expect(page.getByRole('heading', { level: 2, name: 'Practice' })).toBeVisible()
	await page.getByRole('button', { name: 'Finished', exact: true }).click()
	await expect(page.getByRole('status').filter({ hasText: 'Finished: Peak' })).toBeVisible()
	await expect(page.getByRole('heading', { level: 2, name: 'Feedback' })).toBeVisible()
	// An article has no chapters, so its last section is not the end of one.
	await expect(page.getByRole('button', { name: 'Recall chapter' })).toHaveCount(0)
	const card = page.getByRole('region', { name: 'Finished' })
	await expect(card.getByTestId('milestone')).toHaveText(/^\d+ min read · 0 ideas in review · no reviews yet$/)
	await card.getByLabel('Key lesson 1').fill('Practise at the edge of what you can do.')
	await card.getByLabel('Key lesson 2').fill('Feedback has to come fast to help.')
	await card.getByRole('button', { name: 'Save lessons' }).click()
	await expect(card.getByRole('listitem')).toHaveText(['Practise at the edge of what you can do.', 'Feedback has to come fast to help.'])
	await expect(card.getByLabel('Key lesson 3')).toBeVisible()
	await card.scrollIntoViewIfNeeded()
	await proof(page, testInfo, 'milestone')

	const [user] = await sql<{ id: string }>('select id from users where email = $1', [email])
	const finished = () =>
		sql<{ id: string; text: string; deleted_at: Date | null }>("select id, text, deleted_at from entries where user_id = $1 and type = 'reading.finished'", [user!.id])
	const lessons = () => sql<{ answer: string; entry_id: string; deleted_at: Date | null }>("select answer, entry_id, deleted_at from cards where user_id = $1 and kind = 'lesson' order by position", [user!.id])
	const [entry] = await finished()
	expect(await finished()).toHaveLength(1)
	expect(entry!.text).toBe('Practise at the edge of what you can do.\nFeedback has to come fast to help.')
	expect((await lessons()).map((c) => [c.answer, c.entry_id])).toEqual([
		['Practise at the edge of what you can do.', entry!.id],
		['Feedback has to come fast to help.', entry!.id],
	])

	// On Mind: the milestone in the entry list, the reading under Finished this year, and its lessons due.
	await page.goto('/mind')
	await expect(page.getByTestId('entry').filter({ hasText: 'Finished Peak' })).toBeVisible()
	await expect(page.getByRole('region', { name: 'Finished this year' }).getByRole('link', { name: 'Peak' })).toBeVisible()
	await expect(page.getByTestId('reading')).toHaveCount(0)
	await expect(page.getByTestId('mind-due')).toHaveText('2')
	await proof(page, testInfo, 'mind-finished')

	// Undo takes back the entry and its lesson cards, and the reading is back in Reading now.
	await page.getByRole('region', { name: 'Finished this year' }).getByRole('link', { name: 'Peak' }).click()
	await page.getByRole('region', { name: 'Finished' }).getByRole('button', { name: 'Undo finished' }).click()
	await expect(page.getByRole('button', { name: 'Finished', exact: true }).first()).toBeVisible()
	expect((await finished())[0]!.deleted_at).not.toBeNull()
	expect((await lessons()).every((c) => c.deleted_at)).toBe(true)
	await page.goto('/mind')
	await expect(page.getByTestId('entry').filter({ hasText: 'Finished Peak' })).toHaveCount(0)
	await expect(page.getByRole('region', { name: 'Finished this year' })).toHaveCount(0)
	await expect(page.getByTestId('reading').filter({ hasText: 'Peak' })).toBeVisible()
	await expect(page.getByTestId('mind-due')).toHaveText('0')
})

/** The member's saved ideas from a reading, with what the reader and Ideas page show of them. */
const savedIdeas = (readingId: string) =>
	sql<{ id: string; section_id: string; quote: string; answer: string; prompt: string; due_at: Date; started_at: Date | null; state: { step: number | null } }>(
		"select id, section_id, quote, answer, prompt, due_at, started_at, state from cards where reading_id = $1 and origin = 'member' and kind = 'idea' and deleted_at is null",
		[readingId],
	)
const longWords = (text: string) => text.toLowerCase().match(/[a-z]{4,}/g) ?? []

test('Save idea turns a selected passage into a card due in 1 day, listed on Ideas under its reading; with a key, AI writes its cue', async ({ page }, testInfo) => {
	const { readingId, ids } = await openWithKey(page)
	const paragraph = page.locator('article [data-block] p').first()
	const quote = (await paragraph.innerText()).replace(/\s+/g, ' ').trim()

	// A passage too long for one idea says so, and offers nothing to save.
	await page.locator('article').evaluate((article) => document.getSelection()!.selectAllChildren(article))
	await expect(page.getByRole('status').filter({ hasText: 'Pick one idea, not a page.' })).toBeVisible()
	await expect(page.getByRole('button', { name: 'Save idea' })).toHaveCount(0)

	// Selecting one paragraph offers Save idea; the card shows the quote, and Enter saves it.
	await paragraph.click({ clickCount: 3 })
	await expect(page.getByRole('button', { name: 'Save idea' })).toBeVisible()
	await proof(page, testInfo, 'selection')
	await page.getByRole('button', { name: 'Save idea' }).click()
	const dialog = page.getByRole('dialog', { name: 'Save idea' })
	await expect(dialog.getByText(quote)).toBeVisible()
	await proof(page, testInfo, 'save-idea')
	await dialog.getByLabel('In your words (optional)').press('Enter')
	await expect(page.getByRole('status').filter({ hasText: 'Idea saved. It comes back tomorrow.' })).toBeVisible()

	const [card] = await savedIdeas(readingId)
	expect(card).toMatchObject({ section_id: ids[0], quote, answer: quote, state: expect.objectContaining({ step: 1 }) })
	expect(card!.started_at).not.toBeNull()
	expect(Math.abs(minutesUntil(card!.due_at) - DAY_MINUTES)).toBeLessThanOrEqual(1)
	// The fallback cue gives way to one the AI writes, which doesn't give the quote's words away.
	await expect.poll(async () => (await savedIdeas(readingId))[0]!.prompt, { timeout: 10_000 }).toBe('What did you want to keep from this part?')
	const quoteWords = new Set(longWords(quote))
	expect(longWords('What did you want to keep from this part?').filter((w) => quoteWords.has(w))).toEqual([])

	// Saving the same passage again opens the first card, to edit, instead of a second one.
	await paragraph.click({ clickCount: 3 })
	await page.getByRole('button', { name: 'Save idea' }).click()
	const again = page.getByRole('dialog', { name: 'You saved this idea already' })
	await expect(again.getByLabel('Question to ask yourself (optional)')).toHaveValue('What did you want to keep from this part?')
	await again.getByLabel('In your words (optional)').fill('The engine runs one job at a time.')
	await again.getByRole('button', { name: 'Save' }).click()
	await expect(page.getByRole('status').filter({ hasText: 'Idea updated.' })).toBeVisible()
	expect(await savedIdeas(readingId)).toEqual([expect.objectContaining({ id: card!.id, answer: 'The engine runs one job at a time.' })])

	// On Ideas: the idea under its reading, due tomorrow, linking back to its passage.
	await page.goto('/mind')
	await page.getByRole('link', { name: 'Ideas', exact: true }).click()
	const title = await sql<{ title: string }>('select title from readings where id = $1', [readingId]).then((r) => r[0]!.title)
	const group = page.getByRole('region', { name: title })
	const idea = group.getByTestId('saved-idea')
	await expect(idea).toHaveCount(1)
	await expect(idea.getByText(quote)).toBeVisible()
	await expect(idea.getByText('In your words: The engine runs one job at a time.')).toBeVisible()
	await expect(idea.getByTestId('idea-due')).toHaveText('Back tomorrow')
	await proof(page, testInfo, 'ideas')
	await idea.getByRole('link', { name: 'Open passage' }).click()
	await expect(page).toHaveURL(new RegExp(`/mind/read/${readingId}\\?section=${ids[0]}`))
	await expect(page.locator(`article[data-section="${ids[0]}"]`)).toBeVisible()

	// Remove takes it off Ideas; Undo brings it back.
	await page.goBack()
	await idea.getByRole('button', { name: 'Remove' }).click()
	await expect(idea).toHaveCount(0)
	await page.getByRole('button', { name: 'Undo' }).click()
	await expect(idea).toHaveCount(1)
})

test('Explain on a selected passage explains it from first principles over the reader, then as an analogy or an example, and Save idea keeps it', async ({ page }, testInfo) => {
	const { readingId, ids } = await openWithKey(page)
	const paragraph = page.locator('article [data-block] p').first()
	const quote = (await paragraph.innerText()).replace(/\s+/g, ' ').trim()
	const explainCalls = () =>
		sql<{ n: number }>("select count(*)::int as n from ai_calls where purpose = 'explain-passage' and user_id = (select user_id from readings where id = $1)", [readingId]).then(
			(r) => r[0]!.n,
		)

	// The bar under a selection offers both.
	await paragraph.click({ clickCount: 3 })
	const bar = page.getByRole('toolbar', { name: 'Selection' })
	await expect(bar.getByRole('button')).toHaveText(['Save idea', 'Explain'])
	await proof(page, testInfo, 'selection-bar')

	// From first principles at once, resting on a sentence of the section.
	await bar.getByRole('button', { name: 'Explain' }).click()
	const dialog = page.getByRole('dialog', { name: 'Explain' })
	await expect(dialog.getByText(quote, { exact: true })).toBeVisible()
	const explanation = dialog.getByTestId('explanation')
	await expect(explanation).toContainText(`From first principles: "${quote}" holds`)
	await expect(explanation).toContainText('From the text: “')
	await expect(dialog.getByRole('button', { name: 'From first principles' })).toHaveAttribute('aria-pressed', 'true')
	await proof(page, testInfo, 'explain')

	// Another way in: an analogy, then a worked example with code.
	await dialog.getByRole('button', { name: 'Analogy' }).click()
	await expect(explanation).toContainText('Think of a kitchen')
	await expect(explanation).toContainText('The analogy breaks down')
	await dialog.getByRole('button', { name: 'Example' }).click()
	await expect(explanation.locator('pre')).toHaveText('let gap = 1\nconsole.log(gap * 2)')
	// The pointer resting on the pressed pill draws it faded in a full-page capture.
	await page.mouse.move(0, 0)
	await proof(page, testInfo, 'explain-example')
	// Back to the first explanation: shown again without another AI call.
	await dialog.getByRole('button', { name: 'From first principles' }).click()
	await expect(explanation).toContainText('From first principles')
	expect(await explainCalls()).toBe(3)

	// Save idea from the explanation opens the idea form for the same passage.
	await dialog.getByRole('button', { name: 'Save idea' }).click()
	await expect(page.getByRole('dialog', { name: 'Explain' })).toHaveCount(0)
	const save = page.getByRole('dialog', { name: 'Save idea' })
	await expect(save.getByText(quote)).toBeVisible()
	await save.getByLabel('In your words (optional)').fill('Each part rests on the cause underneath it.')
	await save.getByRole('button', { name: 'Save' }).click()
	await expect(page.getByRole('status').filter({ hasText: 'Idea saved. It comes back tomorrow.' })).toBeVisible()
	expect(await savedIdeas(readingId)).toEqual([expect.objectContaining({ section_id: ids[0], quote, answer: 'Each part rests on the cause underneath it.' })])

	// Esc closes Explain and keeps the place in the reading.
	await paragraph.click({ clickCount: 3 })
	await bar.getByRole('button', { name: 'Explain' }).click()
	await expect(explanation).toContainText('From first principles')
	await page.keyboard.press('Escape')
	await expect(page.getByRole('dialog', { name: 'Explain' })).toHaveCount(0)
	await expect(paragraph).toBeVisible()
})
