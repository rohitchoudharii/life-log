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
