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
