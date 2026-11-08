import { expect, type Page } from '@playwright/test'
import { invite, newEmail } from './db'

/** Joins as a new member in this page and lands on Home. */
export async function joinAs(page: Page, name = 'Rohit') {
	const email = newEmail()
	await page.goto(await invite(email))
	await page.getByLabel('Your name').fill(name)
	await page.getByLabel('Choose a password').fill('swallows come home')
	await page.getByLabel('Type it again').fill('swallows come home')
	await page.getByRole('button', { name: 'Set password and enter' }).click()
	await expect(page.getByRole('heading', { name: `Welcome, ${name}` })).toBeVisible()
	return email
}
