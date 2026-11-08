import { execFileSync } from 'node:child_process'
import { expect, type Page, test } from '@playwright/test'
import { ageSessions, invite, newEmail } from './db'
import { e2eEnv } from './env'

const PASSWORD = 'swallows come home'

async function join(page: Page, link: string, name = 'Rohit', password = PASSWORD) {
	await page.goto(link)
	await page.getByLabel('Your name').fill(name)
	await page.getByLabel('Choose a password').fill(password)
	await page.getByLabel('Type it again').fill(password)
	await page.getByRole('button', { name: 'Set password and enter' }).click()
	await expect(page.getByRole('heading', { name: `Welcome, ${name}` })).toBeVisible()
}

async function signIn(page: Page, email: string, password = PASSWORD) {
	await page.getByLabel('Email').fill(email)
	await page.getByLabel('Password', { exact: true }).fill(password)
	await page.getByRole('button', { name: 'Sign in' }).click()
}

async function signOut(page: Page) {
	await page.goto('/settings')
	await page.getByRole('main').getByRole('button', { name: 'Sign out' }).click()
	await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
	await page.goto('/')
}

test('an invite link from `pnpm invite` sets a password and signs in, and the session survives a reload', async ({
	page,
}) => {
	const email = newEmail()
	const out = execFileSync('pnpm', ['--silent', '--filter', '@life-log-club/server', 'invite', email], {
		env: { ...process.env, ...e2eEnv },
		encoding: 'utf8',
	})
	const link = out.match(/\/welcome#\S+/)?.[0]
	expect(link, out).toBeTruthy()
	await join(page, link!)
	await expect(page).toHaveURL('/')
	await page.reload()
	await expect(page.getByRole('heading', { name: 'Welcome, Rohit' })).toBeVisible()
})

test('signing in needs the right password, and an unknown email gets the same answer', async ({ page }) => {
	const email = newEmail()
	await join(page, await invite(email))
	await signOut(page)

	await signIn(page, email, 'not my password')
	await expect(page.getByRole('alert')).toHaveText('Email or password is wrong.')
	await signIn(page, newEmail())
	await expect(page.getByRole('alert')).toHaveText('Email or password is wrong.')

	await signIn(page, email.toUpperCase())
	await expect(page.getByRole('heading', { name: 'Welcome, Rohit' })).toBeVisible()
})

test('five wrong passwords lock the account, even against the right one', async ({ page }) => {
	const email = newEmail()
	await join(page, await invite(email))
	await signOut(page)
	for (let i = 0; i < 5; i++) {
		await signIn(page, email, `wrong guess ${i}`)
		await expect(page.getByRole('alert')).toHaveText('Email or password is wrong.')
	}
	await signIn(page, email)
	await expect(page.getByRole('alert')).toHaveText('Too many wrong tries. Wait 15 minutes, then try again.')
})

test('an invite link works only once', async ({ page }) => {
	const link = await invite(newEmail())
	await join(page, link)
	await signOut(page)
	await page.goto(link)
	await page.getByLabel('Your name').fill('Someone else')
	await page.getByLabel('Choose a password').fill('another password')
	await page.getByLabel('Type it again').fill('another password')
	await page.getByRole('button', { name: 'Set password and enter' }).click()
	await expect(page.getByRole('alert')).toHaveText(
		'This invite link has expired or was already used. Ask for a new one.',
	)
})

test('a device signed out from another device is asked to sign in again', async ({ browser }) => {
	const email = newEmail()
	const lost = await browser.newPage()
	await join(lost, await invite(email))

	const other = await browser.newPage()
	await other.goto('/devices')
	await signIn(other, email)
	const rows = other.getByTestId('device')
	await expect(rows).toHaveCount(2)
	await expect(rows.filter({ hasText: 'This device' })).toHaveCount(1)
	await rows.filter({ hasNotText: 'This device' }).getByRole('button', { name: 'Sign out' }).click()
	await expect(rows).toHaveCount(1)

	await lost.reload()
	await expect(lost.getByRole('heading', { name: 'Sign in' })).toBeVisible()
	await other.reload()
	await expect(other.getByRole('heading', { name: 'Signed-in devices' })).toBeVisible()
})

test('a device unused for 30 days must sign in again, and one used within 30 days stays in', async ({ page }) => {
	const email = newEmail()
	await join(page, await invite(email))

	await ageSessions(email, 29)
	await page.reload()
	await expect(page.getByRole('heading', { name: 'Welcome, Rohit' })).toBeVisible()

	await ageSessions(email, 31)
	await page.reload()
	await expect(page.getByText('You have been away from this device for 30 days, so sign in again.')).toBeVisible()
	await signIn(page, email)
	await expect(page.getByRole('heading', { name: 'Welcome, Rohit' })).toBeVisible()
})
