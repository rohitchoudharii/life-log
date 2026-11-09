import { randomUUID } from 'node:crypto'
import { ORPCError } from '@orpc/client'
import { expect, type Page, test } from '@playwright/test'
import { newMember } from './api'
import { FAKE_SITE, GOOD_ANTHROPIC_KEY } from './env'
import { joinAs } from './session'

async function addLink(page: Page, url: string) {
	await page.getByLabel('Add a reading').fill(url)
	await page.getByRole('button', { name: 'Add', exact: true }).click()
}
const readings = (page: Page) => page.getByTestId('reading')

test('a pasted link shows at once as importing, then opens to its sections', async ({ page, isMobile }) => {
	await joinAs(page)
	await page.goto('/mind')
	await expect(page.getByText('Nothing to read yet.')).toBeVisible()
	// The fake site takes 1.5 seconds to answer, so the importing state is there to see.
	await addLink(page, `${FAKE_SITE}/articles/spaced-repetition?utm_source=newsletter`)
	await expect(readings(page)).toHaveCount(1)
	await expect(readings(page)).toContainText('Importing…')
	await expect(readings(page).getByRole('link', { name: /Spaced repetition/ })).toBeVisible({ timeout: 15_000 })
	await expect(readings(page)).toContainText('11 sections')

	await readings(page).getByRole('link').click()
	await expect(page.getByRole('heading', { level: 1, name: 'Spaced repetition' })).toBeVisible()
	await expect(page.getByText('Spaced repetition is an evidence-based learning technique that is usually performed with flashcards.')).toBeVisible()
	if (isMobile) await page.getByRole('button', { name: /^Contents/ }).click()
	await page.getByRole('navigation', { name: 'Contents' }).getByRole('button', { name: 'History', exact: true }).click()
	await expect(page.getByRole('heading', { level: 2, name: 'History' })).toBeVisible()
	await expect(page.getByText('first conceived of in the 1880s by German scientist Hermann Ebbinghaus')).toBeVisible()
	await page.getByRole('button', { name: 'Next section' }).click()
	await expect(page.getByRole('heading', { level: 2, name: 'Research and application' })).toBeVisible()
})

test('the same link added twice is one reading, and the second add opens it', async ({ page }) => {
	await joinAs(page)
	await page.goto('/mind')
	const link = `${FAKE_SITE}/articles/execution-model`
	await addLink(page, link)
	await expect(readings(page).getByRole('link', { name: /JavaScript execution model/ })).toBeVisible({ timeout: 15_000 })
	await addLink(page, `${link}#closures`)
	await expect(page.getByRole('status')).toContainText('You already have this reading.')
	await expect(page.getByRole('heading', { level: 1, name: 'JavaScript execution model' })).toBeVisible()
	await page.goto('/mind')
	await expect(readings(page)).toHaveCount(1)
})

test('links the server must not or cannot open fail with a message saying what to do', async ({ page }) => {
	await joinAs(page)
	await page.goto('/mind')
	for (const [url, message] of <const>[
		['http://127.0.0.1:8788/health', 'Life Log Club can only open public web pages.'],
		[`${FAKE_SITE}/to-private`, 'Life Log Club can only open public web pages.'],
		[`${FAKE_SITE}/members-only`, 'This page needs you to be signed in. The Chrome extension will capture it later.'],
		[`${FAKE_SITE}/gone`, "The site says this page doesn't exist (404). Check the link."],
	]) {
		await addLink(page, url)
		await expect(readings(page).filter({ hasText: url }).getByRole('alert')).toHaveText(message, { timeout: 15_000 })
	}
	// A failed reading can be removed, with Undo.
	const gone = readings(page).filter({ hasText: `${FAKE_SITE}/gone` })
	await gone.getByRole('button', { name: 'Remove' }).click()
	await expect(gone).toHaveCount(0)
	await expect(readings(page)).toHaveCount(3)

	await addLink(page, 'hello world')
	await expect(page.getByRole('status')).toContainText("That isn't a web address. Check the link and try again.")
	await expect(readings(page)).toHaveCount(3)
})

test("a member can't see another member's reading, by id or in their list", async ({}, info) => {
	test.skip(info.project.name !== 'desktop', 'API only')
	const a = await newMember('A')
	const b = await newMember('B')
	const reading = await a.client.readings.add({ id: randomUUID(), url: `${FAKE_SITE}/articles/execution-model` })
	await expect.poll(async () => (await a.client.readings.get({ id: reading.id })).status, { timeout: 15_000 }).toBe('ready')
	const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e instanceof ORPCError ? e.code : String(e)))
	expect(await code(b.client.readings.get({ id: reading.id }))).toBe('NOT_FOUND')
	expect(await b.client.readings.list()).toEqual([])
	// Reusing A's id for B's own add can't reach A's reading.
	expect(await code(b.client.readings.add({ id: reading.id, url: `${FAKE_SITE}/articles/spaced-repetition` }))).toBe('CONFLICT')
	const { contents } = await a.client.readings.get({ id: reading.id })
	expect(await code(b.client.readings.section({ id: contents[0]!.id }))).toBe('NOT_FOUND')
})

test('a long article with no headings gets AI headings with a key, and stays one section without one', async ({ page, isMobile }) => {
	await joinAs(page)
	await page.goto('/mind')
	await addLink(page, `${FAKE_SITE}/articles/no-headings`)
	await expect(readings(page)).toContainText('1 section', { timeout: 15_000 })
	await readings(page).getByRole('link').click()
	await expect(page.getByRole('heading', { level: 2, name: 'Notes on attention' })).toBeVisible()
	await expect(page.getByText('Heading added by AI')).toHaveCount(0)

	// With a key, the same article gets headings (e2e/fake-llm.ts decides where they go).
	const saved = await page.request.post('/rpc/ai/saveKey', {
		headers: { 'x-csrf-token': 'orpc' },
		data: { json: { provider: 'anthropic', apiKey: GOOD_ANTHROPIC_KEY } },
	})
	expect(saved.ok()).toBe(true)
	await page.goto('/mind')
	await addLink(page, `${FAKE_SITE}/articles/no-headings?copy=2`)
	await expect(readings(page).filter({ hasText: '2 sections' })).toBeVisible({ timeout: 15_000 })
	await readings(page).filter({ hasText: '2 sections' }).getByRole('link').click()
	await expect(page.getByRole('heading', { level: 2, name: 'How it starts' })).toBeVisible()
	await expect(page.getByText("Heading added by AI. The text is the author's.")).toBeVisible()
	await expect(page.getByText(/^Paragraph 1\. Attention is where the mind/)).toBeVisible()
	if (isMobile) await page.getByRole('button', { name: /^Contents/ }).click()
	await page.getByRole('navigation', { name: 'Contents' }).getByRole('button', { name: 'Where it leads' }).click()
	await expect(page.getByText(/^Paragraph 9\. Attention/)).toBeVisible()
})
