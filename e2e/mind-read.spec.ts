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

const DAY = 86_400_000
/** Each key idea of the attempt with its mark and how long until it comes back, in minutes. */
async function marksAndGaps(attemptId: string) {
	const [attempt] = await sql<{ results: { cardId: string; status: string }[]; submitted_at: Date }>(
		'select results, submitted_at from recall_attempts where id = $1',
		[attemptId],
	)
	const cards = await sql<{ id: string; due_at: Date; started_at: Date | null; level: number }>('select id, due_at, started_at, level from cards where id = any($1)', [
		attempt!.results.map((r) => r.cardId),
	])
	return attempt!.results.map((r) => {
		const card = cards.find((c) => c.id === r.cardId)!
		return { status: r.status, started: card.started_at !== null, level: card.level, minutes: Math.round((card.due_at.getTime() - Date.now()) / 60_000) }
	})
}
const attemptIdOf = (page: Page) => new URL(page.url()).pathname.split('/').at(-1)!

test('after reading, Recall hides the text, grades the dump against each key idea, and starts the cards', async ({ page }, testInfo) => {
	const { ids } = await openWithKey(page)
	await stay(page)
	await expect.poll(() => writeStatus(ids[0]!), { timeout: 15_000 }).toBe('ready')
	const ideas = await sql<{ answer: string }>("select answer from cards where section_id = $1 and origin = 'ai' order by position", [ids[0]])
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

	const map = page.getByRole('list', { name: 'Recall map' })
	await expect(map.getByRole('listitem')).toHaveCount(ideas.length, { timeout: 15_000 })
	await expect(map.getByRole('listitem').first()).toContainText('Covered')
	await expect(map.getByRole('listitem').first()).toContainText('Back tomorrow')
	await expect(map.getByRole('listitem').first()).toContainText('From the text:')
	await proof(page, testInfo, 'recall-results')

	// The dump can be personal, so only its encrypted form is stored.
	const [stored] = await sql<{ text_ct: string }>('select text_ct from recall_attempts where id = $1', [attemptIdOf(page)])
	expect(stored!.text_ct).not.toContain('I remember this')
	await page.getByText('What you wrote').click()
	await expect(page.getByText(`I remember this: ${ideas[0]!.answer}`)).toBeVisible()

	// Covered ideas come back in a day, missed ones in 10 minutes; every card has started.
	const marks = await marksAndGaps(attemptIdOf(page))
	expect(marks[0]).toMatchObject({ status: 'covered', started: true, level: 1 })
	expect(marks.some((m) => m.status === 'missing')).toBe(true)
	for (const m of marks) {
		expect(m.started).toBe(true)
		if (m.status === 'missing') expect(m).toMatchObject({ minutes: 10, level: 0 })
		else expect(Math.abs(m.minutes - DAY / 60_000)).toBeLessThanOrEqual(1)
	}
	expect((await sql('select recalled_at from sections where id = $1', [ids[0]]))[0]).toMatchObject({ recalled_at: expect.any(Date) })

	// Done goes on reading at the next section.
	const [next] = await sql<{ title: string }>('select title from sections where id = $1', [ids[1]])
	await page.getByRole('button', { name: 'Done' }).click()
	await expect(sectionTitle(page)).toHaveText(next!.title)
})

test('Recall on a section not written yet opens the dump at once, and Nothing comes to mind marks every idea missed', async ({ page }, testInfo) => {
	const { ids } = await openWithKey(page)
	expect(await writeStatus(ids[0]!)).toBe('none')
	await page.getByRole('button', { name: 'Recall this section' }).click()
	await expect(page.getByLabel('What you remember')).toBeVisible()
	await page.getByRole('button', { name: 'Nothing comes to mind' }).click()
	// The ideas are still being written: the member waits on one calm line.
	await expect(page.getByRole('status').filter({ hasText: 'Checking against the text…' })).toBeVisible()
	await proof(page, testInfo, 'checking')

	const map = page.getByRole('list', { name: 'Recall map' })
	await expect(map.getByRole('listitem').first()).toBeVisible({ timeout: 15_000 })
	await expect(map.getByText('Covered')).toHaveCount(0)
	await expect(map.getByText('Vague')).toHaveCount(0)
	await expect(map.getByRole('listitem').first()).toContainText('Back in 10 minutes')
	await proof(page, testInfo, 'nothing-comes-to-mind')
	const marks = await marksAndGaps(attemptIdOf(page))
	expect(marks.length).toBeGreaterThanOrEqual(2)
	expect(marks.every((m) => m.status === 'missing' && m.started && m.minutes === 10)).toBe(true)
	// An empty dump needs no AI call to grade.
	const calls = await sql<{ purpose: string }>("select purpose from ai_calls where user_id = (select user_id from sections where id = $1) and purpose = 'grade-recall'", [ids[0]])
	expect(calls).toEqual([])
})
