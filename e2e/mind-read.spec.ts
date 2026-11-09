import { expect, type Page, test } from '@playwright/test'
import { sql } from './db'
import { FAKE_SITE, GOOD_ANTHROPIC_KEY } from './env'
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

test('Review without a key: self-rated cards, 20 at a time with Keep going, filters, and answer keys that never switch worlds', async ({ page }, testInfo) => {
	const desktop = testInfo.project.name === 'desktop'
	await joinAs(page)
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
		"select c.prompt, l.ask, l.rating, l.graded_by from review_log l join cards c on c.id = l.card_id where c.prompt like 'Lesson %' and l.user_id = (select user_id from cards where prompt = 'Lesson 1: what did it teach?' order by created_at desc limit 1) order by l.id",
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
