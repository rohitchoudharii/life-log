import { expect, type Page } from '@playwright/test'
import { invite, newEmail, sql } from './db'

/**
 * Joins as a new member in this page and lands on Home. Unless `sample` is set, the member
 * starts without the sample reading, as if they had removed it, so Mind starts empty.
 */
export async function joinAs(page: Page, name = 'Rohit', { sample = false } = {}) {
	const email = newEmail()
	await page.goto(await invite(email))
	await page.getByLabel('Your name').fill(name)
	await page.getByLabel('Choose a password').fill('swallows come home')
	await page.getByLabel('Type it again').fill('swallows come home')
	await page.getByRole('button', { name: 'Set password and enter' }).click()
	await expect(page.getByRole('heading', { name: `Welcome, ${name}` })).toBeVisible()
	if (!sample)
		await sql(
			`insert into preferences (user_id, sample_added_at) select id, now() from users where email = $1
			on conflict (user_id) do update set sample_added_at = now()`,
			[email],
		)
	return email
}
