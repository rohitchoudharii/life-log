import { expect, type Page, test } from '@playwright/test'
import { invite, newEmail, sql } from './db'
import { GOOD_ANTHROPIC_KEY, GOOD_OPENAI_KEY } from './env'
import { proof } from './proof'

async function joinAndOpenSettings(page: Page) {
	const email = newEmail()
	await page.goto(await invite(email))
	await page.getByLabel('Your name').fill('Rohit')
	await page.getByLabel('Choose a password').fill('swallows come home')
	await page.getByLabel('Type it again').fill('swallows come home')
	await page.getByRole('button', { name: 'Set password and enter' }).click()
	await expect(page.getByRole('heading', { name: 'Welcome, Rohit' })).toBeVisible()
	await page.getByRole('link', { name: 'Account' }).click()
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

test('Settings shows this month’s AI use against the budget, and Mind says when background writing pauses', async ({ page }, testInfo) => {
	const email = await joinAndOpenSettings(page)
	const [user] = await sql<{ id: string }>('select id from users where email = $1', [email])
	// Two calls this month at 10,000 tokens in and 2,000 out on a Haiku model ($1 and $5 per million),
	// and one from 40 days ago that no longer counts.
	await sql(
		`insert into ai_calls (user_id, purpose, model, input_tokens, output_tokens, ok, ms, at)
		 values ($1, 'write-section', 'claude-haiku-5-5', 10000, 2000, true, 900, now()),
		        ($1, 'grade-recall', 'claude-haiku-5-5', 10000, 2000, true, 700, now()),
		        ($1, 'write-section', 'claude-haiku-5-5', 10000, 2000, true, 800, now() - interval '40 days')`,
		[user!.id],
	)
	await page.reload()
	await expect(page.getByTestId('ai-usage')).toHaveText('This month: 2 calls · about $0.04 of $5')
	await proof(page, testInfo, 'settings-usage')
	await page.getByRole('link', { name: 'Mind' }).first().click()
	await expect(page.getByRole('heading', { name: 'The reading room' })).toBeVisible()
	await expect(page.getByText(/Paused writing questions/)).toHaveCount(0)

	await page.goto('/settings')
	await page.getByLabel('Monthly budget in US dollars').fill('0')
	await page.getByRole('button', { name: 'Save budget' }).click()
	await expect(page.getByTestId('ai-usage')).toHaveText('This month: 2 calls · about $0.04 of $0')
	await proof(page, testInfo, 'settings-budget-used')

	await page.goto('/mind')
	const paused = page.getByRole('status').filter({ hasText: 'Paused writing questions: this month’s AI budget is used.' })
	await expect(paused).toBeVisible()
	await proof(page, testInfo, 'mind-paused')
	await paused.getByRole('link', { name: 'Settings' }).click()
	await expect(page.getByRole('heading', { name: 'AI usage' })).toBeVisible()
})

test('Settings → Review sets how well to remember with one click, 90% at first, and keeps it', async ({ page }, testInfo) => {
	const email = await joinAndOpenSettings(page)
	const target = page.getByRole('group', { name: 'When an idea comes back, aim to remember it' })
	await expect(target.getByRole('radio', { name: '90%' })).toBeChecked()
	await expect(target).toContainText('Higher means more reviews.')
	await proof(page, testInfo, 'settings-review-target')

	await target.getByText('95%').click()
	await expect(target.getByRole('radio', { name: '95%' })).toBeChecked()
	await expect
		.poll(async () => (await sql<{ desired_retention: number }>('select desired_retention from preferences where user_id = (select id from users where email = $1)', [email]))[0]?.desired_retention)
		.toBeCloseTo(0.95)
	await page.reload()
	await expect(target.getByRole('radio', { name: '95%' })).toBeChecked()
	await expect(target.getByRole('radio', { name: '90%' })).not.toBeChecked()
	await proof(page, testInfo, 'settings-review-target-95')

	// Tuning to the member's own memory waits for 1,000 answers, and says so.
	const tuning = page.getByTestId('tuning')
	await expect(tuning).toHaveText('After 1,000 answers (you have 0), the schedule tunes itself to your memory each month.')
	await proof(page, testInfo, 'settings-tuning-waiting')
	// After a monthly fit that predicted held-out answers 12% better, the line says when and by how much.
	await sql(
		`with u as (select id from users where email = $1)
		insert into scheduler_fits (user_id, reviews, held_out, weights, current_log_loss, new_log_loss, kept) select id, 1040, 260, $2, 0.5, 0.44, true from u`,
		[email, Array(21).fill(0.5)],
	)
	await sql('update preferences set fsrs_weights = $2 where user_id = (select id from users where email = $1)', [email, Array(21).fill(0.5)])
	await page.reload()
	const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
	await expect(tuning).toHaveText(`Tuned to your own memory on ${today}: it predicts your recall 12% better than before.`)
	await tuning.scrollIntoViewIfNeeded()
	await proof(page, testInfo, 'settings-tuned')
})
