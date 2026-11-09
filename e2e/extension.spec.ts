import { execFileSync } from 'node:child_process'
import { test as base, type BrowserContext, chromium, expect, type Page } from '@playwright/test'
import { FAKE_SITE, FAKE_SITE_PORT, WEB_PORT } from './env'
import { joinAs } from './session'

// The members' site is opened at 127.0.0.1, so its images at localhost come from another site.
const MEMBERS = `http://127.0.0.1:${FAKE_SITE_PORT}`
const chapterUrl = `${MEMBERS}/members/chapter-1`
const extensionDir = new URL('../apps/extension/', import.meta.url).pathname

/**
 * Chromium with the extension's e2e build loaded, built for the e2e web app. The member signs in
 * to the web app in the same browser, as they would, and the extension uses that session.
 */
const test = base.extend<{ page: Page }, { browser_: { context: BrowserContext; id: string } }>({
	browser_: [
		async ({}, use) => {
			execFileSync('pnpm', ['run', 'build:e2e'], {
				cwd: extensionDir,
				env: { ...process.env, WXT_APP_ORIGIN: `http://localhost:${WEB_PORT}`, WXT_E2E_SITES: [MEMBERS, FAKE_SITE].join(',') },
				stdio: 'pipe',
			})
			const path = `${extensionDir}.output/chrome-mv3-e2e`
			const context = await chromium.launchPersistentContext('', {
				channel: 'chromium',
				baseURL: `http://localhost:${WEB_PORT}`,
				args: [`--disable-extensions-except=${path}`, `--load-extension=${path}`],
			})
			const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
			await use({ context, id: new URL(worker.url()).host })
			await context.close()
		},
		{ scope: 'worker' },
	],
	page: async ({ browser_ }, use) => use(await browser_.context.newPage()),
})

// One browser with the extension, built once, for both tests in turn.
test.describe.configure({ mode: 'default' })

/** The popup, opened as a page for the tab showing `url`, since tests can't click the toolbar. */
const openPopup = (page: Page, id: string, url: string) => page.goto(`chrome-extension://${id}/popup.html?url=${encodeURIComponent(url)}`)

test('the extension saves a page from a site behind a login as the next chapter of a book', async ({ page, browser_ }) => {
	const { context, id } = browser_
	const article = await context.newPage()
	await article.goto(chapterUrl)
	const popup = await context.newPage()

	await openPopup(popup, id, chapterUrl)
	await expect(popup.getByText('Sign in to Life Log Club in this browser first.')).toBeVisible()

	await joinAs(page)
	// The site shows a preview to someone signed out of it: the popup says so before Save.
	await openPopup(popup, id, chapterUrl)
	await expect(popup.getByRole('alert')).toHaveText(
		'This looks like a preview: the text stops at a subscribe box. Sign in to the site, reload the page, then save.',
	)
	await popup.getByLabel('Book').selectOption({ label: 'New book…' })
	await popup.getByLabel('Book title').fill("The Members' Book")
	await popup.getByRole('button', { name: 'Save anyway' }).click()
	await expect(popup.getByRole('status')).toHaveText("Saved to The Members' Book.")

	// Signed in to the site, the whole chapter is there. The book is offered again, and saving replaces the preview.
	await article.goto(`${MEMBERS}/members/login`)
	await expect(article.getByRole('heading', { name: 'When a server leaves' })).toBeVisible()
	await openPopup(popup, id, chapterUrl)
	await expect(popup.getByRole('button', { name: 'Save', exact: true })).toBeVisible()
	await expect(popup.getByRole('alert')).toHaveCount(0)
	await expect(popup.getByLabel('Book')).toHaveValue(/[0-9a-f-]{36}/)
	await expect(popup.getByLabel('Book').locator('option:checked')).toHaveText("The Members' Book")
	await popup.getByRole('button', { name: 'Save', exact: true }).click()
	await expect(popup.getByRole('status')).toHaveText("Updated in The Members' Book.")

	const [reader] = await Promise.all([context.waitForEvent('page'), popup.getByRole('button', { name: 'Open in Life Log Club' }).click()])
	await expect(reader.getByRole('heading', { level: 1, name: 'Chapter 1: Why the ring holds' })).toBeVisible()
	await expect(reader.getByRole('link', { name: "← The Members' Book" })).toBeVisible()
	// The image the site shows only to its members came with the page, read in the member's tab.
	await expect(reader.getByRole('img', { name: 'A ring of four servers' })).toBeVisible()
	await reader.getByRole('img', { name: 'A ring of four servers' }).scrollIntoViewIfNeeded()
	await expect
		.poll(() => reader.getByRole('img', { name: 'A ring of four servers' }).evaluate((img: HTMLImageElement) => img.naturalWidth))
		.toBeGreaterThan(0)

	await page.goto('/mind')
	await expect(page.getByTestId('book')).toContainText("The Members' Book")
	await expect(page.getByTestId('book')).toContainText('0 of 1 chapter read')
	await expect(page.getByTestId('reading')).toHaveCount(0)
})

test('the extension says it can save web pages only', async ({ page, browser_ }) => {
	await page.goto('about:blank')
	await openPopup(page, browser_.id, 'about:blank')
	await expect(page.getByText('Life Log Club can save web pages only.')).toBeVisible()
})
