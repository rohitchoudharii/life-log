import { expect, test } from '@playwright/test'

test('the web app reaches the API and the database', async ({ page }) => {
	await page.goto('/')
	await expect(page.getByText('server ok, database ok')).toBeVisible()
})
