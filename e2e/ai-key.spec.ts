import { expect, type Page, test } from '@playwright/test'
import { invite, newEmail, sql } from './db'
import { GOOD_ANTHROPIC_KEY, GOOD_OPENAI_KEY } from './env'

async function joinAndOpenSettings(page: Page) {
	const email = newEmail()
	await page.goto(await invite(email))
	await page.getByLabel('Your name').fill('Rohit')
	await page.getByLabel('Choose a password').fill('swallows come home')
	await page.getByLabel('Type it again').fill('swallows come home')
	await page.getByRole('button', { name: 'Set password and enter' }).click()
	await expect(page.getByRole('heading', { name: 'Welcome, Rohit' })).toBeVisible()
	await page.getByRole('link', { name: 'Settings' }).click()
	await expect(page.getByRole('heading', { name: 'Your AI key' })).toBeVisible()
	return email
}

test('a rejected key shows why, and a good one is saved encrypted with a low-cost model', async ({ page }) => {
	const email = await joinAndOpenSettings(page)
	await page.getByLabel('API key').fill('sk-ant-wrong-key-9999')
	await page.getByRole('button', { name: 'Check and save' }).click()
	await expect(page.getByRole('alert')).toHaveText('The provider rejected this key. Check that you copied all of it.')

	await page.getByLabel('API key').fill(GOOD_ANTHROPIC_KEY)
	await page.getByRole('button', { name: 'Check and save' }).click()
	await expect(page.getByTestId('ai-key')).toContainText('Anthropic · claude-haiku-5-5 · key ending in 0001')
	await page.reload()
	await expect(page.getByTestId('ai-key')).toContainText('key ending in 0001')

	const [row] = await sql<{ key_ct: string }>(
		'select key_ct from ai_keys where user_id = (select id from users where email = $1)',
		[email],
	)
	expect(row!.key_ct).not.toContain(GOOD_ANTHROPIC_KEY)
	expect(row!.key_ct).toMatch(/^k1\./)
})

test('a key can be removed and replaced with an OpenAI key', async ({ page }) => {
	await joinAndOpenSettings(page)
	await page.getByLabel('API key').fill(GOOD_ANTHROPIC_KEY)
	await page.getByRole('button', { name: 'Check and save' }).click()
	await page.getByRole('button', { name: 'Remove key' }).click()
	await expect(page.getByLabel('API key')).toBeVisible()

	await page.getByText('OpenAI', { exact: true }).click()
	await page.getByLabel('API key').fill(GOOD_OPENAI_KEY)
	await page.getByRole('button', { name: 'Check and save' }).click()
	// The newest small chat model, skipping image models.
	await expect(page.getByTestId('ai-key')).toContainText('OpenAI · gpt-6.1-terra · key ending in 0002')
})
