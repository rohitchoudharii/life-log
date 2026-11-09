import { expect, type Page, test } from '@playwright/test'
import { sql } from './db'
import { proof } from './proof'
import { joinAs } from './session'

const openLog = (page: Page) => page.getByRole('button', { name: '+ Log' }).click()
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Log' })

/** Calls the API from the page, with the page's own session. */
const api = (page: Page, path: string, json: unknown) =>
	page.request.post(`/rpc/${path}`, { headers: { 'x-csrf-token': 'orpc' }, data: { json } })

test('Home opens each world, and Path waits for later', async ({ page }) => {
	await joinAs(page)
	await expect(page.getByText('Coming later: projects, goals and trips.')).toBeVisible()
	for (const [card, url, heading] of [
		['Mind: the reading room', '/mind', 'The reading room'],
		['Body: the training log', '/body', 'The training log'],
		['Heart: the journal', '/heart', 'The journal'],
	] as const) {
		await page.goto('/')
		await page.getByRole('link', { name: card }).click()
		await expect(page).toHaveURL(url)
		await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible()
	}
	await expect(page.locator('[data-world="heart"]')).toBeVisible()
})

test('a gym set logged with + Log shows on Home and Body, and the next one starts from it', async ({ page }) => {
	await joinAs(page)
	await expect(page.getByText('Nothing logged yet. Press + Log, or L on a keyboard.')).toBeVisible()
	await openLog(page)
	await expect(dialog(page)).toBeVisible()
	await dialog(page).getByLabel('Exercise').fill('Bench press')
	await dialog(page).getByLabel('Weight (kg)').fill('80')
	await dialog(page).getByLabel('Reps').fill('8')
	await dialog(page).getByRole('button', { name: 'Save' }).click()
	await expect(dialog(page)).toBeHidden()
	await expect(page.getByRole('status')).toContainText('Saved: Bench press · 80 kg × 8')
	await expect(page.getByTestId('last-set')).toHaveText('80kg × 8')

	// Smart defaults: the next set is one click on Save.
	await openLog(page)
	await expect(dialog(page).getByLabel('Exercise')).toHaveValue('Bench press')
	await expect(dialog(page).getByLabel('Weight (kg)')).toHaveValue('80')
	await dialog(page).getByRole('button', { name: 'Save' }).click()
	await expect(dialog(page)).toBeHidden()

	await page.getByRole('link', { name: 'Body: the training log' }).click()
	await expect(page.getByTestId('sets-week')).toHaveText('2')
	await expect(page.getByTestId('entry').filter({ hasText: 'Bench press · 80 kg × 8' })).toHaveCount(2)
})

test('meals add up to today’s protein, and Undo takes one back', async ({ page }) => {
	await joinAs(page)
	await page.goto('/body')
	for (const [name, grams] of [
		['Protein shake', '30'],
		['Eggs', '18'],
	] as const) {
		await page.getByRole('button', { name: 'Log a meal' }).click()
		await dialog(page).getByLabel('What', { exact: true }).fill(name)
		await dialog(page).getByLabel('Protein (g)').fill(grams)
		await dialog(page).getByRole('button', { name: 'Save' }).click()
		await expect(dialog(page)).toBeHidden()
	}
	await expect(page.getByTestId('protein-today')).toHaveText('48 g')
	await page.getByRole('status').getByRole('button', { name: 'Undo' }).click()
	await expect(page.getByTestId('protein-today')).toHaveText('30 g')
	await expect(page.getByTestId('entry')).toHaveCount(1)
})

test('a meeting note is saved, shows on Home and Heart, and can be removed and restored', async ({ page }) => {
	const email = await joinAs(page)
	await page.goto('/heart')
	await page.getByRole('button', { name: 'Log a meeting' }).click()
	await dialog(page).getByLabel('Who').fill('Kabir')
	await dialog(page).getByLabel('What you talked about').fill('His new job in Pune')
	await dialog(page).getByRole('button', { name: 'Save' }).click()
	await expect(page.getByTestId('entry').filter({ hasText: 'Met Kabir' })).toContainText('His new job in Pune')
	const [row] = await sql<{ text_ct: string | null }>(
		`select text_ct from entries where user_id = (select id from users where email = $1)`,
		[email],
	)
	expect(row!.text_ct).not.toContain('Pune')

	await page.getByRole('button', { name: 'Remove Met Kabir' }).click()
	await expect(page.getByText('Nothing in the journal yet.')).toBeVisible()
	await page.getByRole('status').getByRole('button', { name: 'Undo' }).click()
	await expect(page.getByTestId('entry')).toHaveCount(1)

	await page.goto('/')
	await expect(page.getByTestId('last-person')).toHaveText('Kabir')
})

test('a mood is one tap on Heart', async ({ page }) => {
	await joinAs(page)
	await page.goto('/heart')
	await page.getByRole('group', { name: 'Mood' }).getByRole('button', { name: 'Good' }).click()
	await expect(page.getByText('Today so far: Good')).toBeVisible()
	await page.goto('/')
	await expect(page.getByText('Mood today: Good')).toBeVisible()
})

test('Mind shows the cards due for review', async ({ page }, testInfo) => {
	await joinAs(page)
	const res = await api(page, 'review/add', {
		id: crypto.randomUUID(),
		kind: 'idea',
		prompt: 'What does deliberate practice need besides effort?',
		answer: 'Immediate feedback.',
	})
	expect(res.ok()).toBe(true)
	await page.reload()
	await expect(page.getByTestId('due-count')).toHaveText('1')
	await page.goto('/mind')
	await expect(page.getByTestId('mind-due')).toHaveText('1')
	await expect(page.getByText('What does deliberate practice need besides effort?')).toBeVisible()
	await proof(page, testInfo, 'mind-due')
})

test('keyboard: L opens + Log, Esc closes it, 1 to 4 switch worlds, and typing is never a shortcut', async ({
	page,
}, info) => {
	test.skip(info.project.name === 'phone', 'phones have no keyboard shortcuts')
	await joinAs(page)
	await page.keyboard.press('3')
	await expect(page).toHaveURL('/body')
	await page.keyboard.press('2')
	await expect(page).toHaveURL('/mind')
	await page.keyboard.press('l')
	await expect(dialog(page)).toBeVisible()
	await dialog(page).getByRole('radio', { name: 'Moment' }).click()
	await dialog(page).getByLabel('What happened').pressSequentially('l1 sky over the lake')
	await expect(page).toHaveURL('/mind')
	await page.keyboard.press('Escape')
	await expect(dialog(page)).toBeHidden()
	await page.keyboard.press('1')
	await expect(page).toHaveURL('/')
})

test('on a phone the worlds sit in a bottom bar with + Log in the middle', async ({ page }, info) => {
	test.skip(info.project.name !== 'phone', 'phone layout')
	await joinAs(page)
	const bar = page.getByRole('navigation', { name: 'Worlds' })
	await expect(bar).toBeVisible()
	await bar.getByRole('link', { name: 'Body' }).click()
	await expect(page).toHaveURL('/body')
	await bar.getByRole('button', { name: '+ Log' }).click()
	await expect(dialog(page)).toBeVisible()
	const { width } = page.viewportSize()!
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
})
