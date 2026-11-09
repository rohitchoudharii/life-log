import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { ORPCError } from '@orpc/client'
import { expect, type Page, test } from '@playwright/test'
import { newMember } from './api'
import { FAKE_SITE } from './env'
import { joinAs } from './session'

async function addLink(page: Page, url: string) {
	await page.getByLabel('Add a reading').fill(url)
	await page.getByRole('button', { name: 'Add', exact: true }).click()
}
const readings = (page: Page) => page.getByTestId('reading')
const book = (page: Page) => page.getByTestId('book')
const chapters = (page: Page) => page.getByTestId('chapter')

test('a member makes a book from articles, orders its chapters, and reads it chapter by chapter', async ({ page, isMobile }) => {
	await joinAs(page)
	await page.goto('/mind')
	await addLink(page, `${FAKE_SITE}/books/rings/1.html`)
	await addLink(page, `${FAKE_SITE}/books/rings/2.html`)
	await expect(readings(page).getByRole('link', { name: /2\. Hashing keys/ })).toBeVisible({ timeout: 15_000 })
	await expect(readings(page).getByRole('link', { name: /1\. Why rings/ })).toBeVisible({ timeout: 15_000 })

	await page.getByRole('button', { name: 'New book' }).click()
	await page.getByLabel('Book title').fill('Field notes on rings')
	await page.getByRole('button', { name: 'Save' }).click()
	await expect(book(page)).toContainText('No chapters yet')

	// Each article goes into the book with Add to book, and leaves the list as an article.
	for (const title of ['2. Hashing keys', '1. Why rings']) {
		const card = readings(page).filter({ hasText: title })
		await card.getByRole('button', { name: 'Add to book' }).click()
		await card.getByRole('button', { name: 'Field notes on rings' }).click()
		await expect(page.getByRole('status')).toContainText('Added to Field notes on rings')
	}
	await expect(readings(page)).toHaveCount(0)
	await expect(book(page)).toContainText('0 of 2 chapters read')

	// Chapters are in the order they were added; the arrows move them, and the order is kept.
	await book(page).getByRole('link', { name: /Field notes on rings/ }).click()
	await expect(page.getByRole('heading', { level: 1, name: 'Field notes on rings' })).toBeVisible()
	await expect(chapters(page)).toHaveText([/2\. Hashing keys/, /1\. Why rings/])
	await page.getByRole('button', { name: 'Move up: 1. Why rings' }).click()
	await expect(chapters(page)).toHaveText([/1\. Why rings/, /2\. Hashing keys/])
	await page.reload()
	await expect(chapters(page)).toHaveText([/1\. Why rings/, /2\. Hashing keys/])

	// Continue opens the first chapter not read. Reaching the end of its last section marks it read.
	await page.getByRole('link', { name: 'Continue' }).click()
	await expect(page.getByRole('heading', { level: 1, name: '1. Why rings' })).toBeVisible()
	await expect(page.getByRole('link', { name: '← Field notes on rings' })).toBeVisible()
	await page.getByRole('button', { name: 'Next section' }).click()
	await expect(page.getByRole('heading', { level: 2, name: 'In practice' })).toBeVisible()
	await page.getByRole('button', { name: 'Previous section' }).scrollIntoViewIfNeeded()
	await page.getByRole('link', { name: '← Field notes on rings' }).click()
	await expect(page.getByText('1 of 2 chapters read')).toBeVisible()
	await expect(chapters(page).first()).toContainText('Read')
	await page.getByRole('link', { name: 'Continue' }).click()
	await expect(page.getByRole('heading', { level: 1, name: '2. Hashing keys' })).toBeVisible()

	// Remove from book makes the chapter an article again.
	await page.getByRole('link', { name: '← Field notes on rings' }).click()
	await chapters(page).filter({ hasText: '2. Hashing keys' }).getByRole('button', { name: 'Remove from book' }).click()
	await expect(chapters(page)).toHaveCount(1)
	await expect(page.getByText('1 of 1 chapter read')).toBeVisible()
	await page.getByRole('link', { name: '← Reading room' }).click()
	await expect(readings(page)).toHaveCount(1)
	await expect(readings(page)).toContainText('2. Hashing keys')

	// Removing the book shows its chapters as articles, and Undo puts them back.
	await book(page).getByRole('link').first().click()
	await page.getByRole('button', { name: 'Remove book' }).click()
	await expect(page.getByRole('status')).toContainText('Removed Field notes on rings')
	await expect(book(page)).toHaveCount(0)
	await expect(readings(page)).toHaveCount(2)
	await page.getByRole('button', { name: 'Undo' }).click()
	await expect(book(page)).toHaveCount(1)
	await expect(readings(page)).toHaveCount(1)
	if (isMobile) return
	// A chapter dragged onto another takes its place.
	await readings(page).getByRole('button', { name: 'Add to book' }).click()
	await readings(page).getByRole('button', { name: 'Field notes on rings' }).click()
	await book(page).getByRole('link').first().click()
	await expect(chapters(page)).toHaveText([/1\. Why rings/, /2\. Hashing keys/])
	await chapters(page).nth(1).dragTo(chapters(page).nth(0))
	await expect(chapters(page)).toHaveText([/2\. Hashing keys/, /1\. Why rings/])
})

test('Add to book makes a new book with New book…, and offers no book for a file', async ({ page }) => {
	await joinAs(page)
	await page.goto('/mind')
	await addLink(page, `${FAKE_SITE}/articles/execution-model`)
	const card = readings(page).filter({ hasText: 'JavaScript execution model' })
	await expect(card.getByRole('link')).toBeVisible({ timeout: 15_000 })
	await card.getByRole('button', { name: 'Add to book' }).click()
	await card.getByRole('button', { name: 'New book…' }).click()
	await card.getByLabel('Book title').fill('JavaScript notes')
	await card.getByRole('button', { name: 'Save' }).click()
	await expect(page.getByRole('status')).toContainText('Added to JavaScript notes')
	await expect(book(page)).toContainText('JavaScript notes')
	await expect(book(page)).toContainText('0 of 1 chapter read')

	await page.getByLabel('EPUB or PDF file').setInputFiles(new URL('../apps/server/src/import/fixtures/the-prince.epub', import.meta.url).pathname)
	await expect(readings(page).getByRole('link', { name: /The Prince/ })).toBeVisible({ timeout: 30_000 })
	await expect(readings(page).filter({ hasText: 'The Prince' }).getByRole('button', { name: 'Add to book' })).toHaveCount(0)
})

test("books hold only the member's own articles from links", async ({}, info) => {
	test.skip(info.project.name !== 'desktop', 'API only')
	const a = await newMember('A')
	const b = await newMember('B')
	const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e instanceof ORPCError ? `${e.code}: ${e.message}` : String(e)))
	const article = await a.client.readings.add({ id: randomUUID(), url: `${FAKE_SITE}/articles/execution-model` })
	const file = await a.client.readings.addFile({
		id: randomUUID(),
		file: new File([readFileSync(new URL('../apps/server/src/import/fixtures/the-prince.epub', import.meta.url))], 'the-prince.epub'),
	})
	const aBook = await a.client.books.create({ id: randomUUID(), title: 'Mine' })
	expect(await code(a.client.books.addChapter({ bookId: aBook.id, readingId: file.id }))).toBe(
		'BAD_REQUEST: Only articles can be chapters of a book, not a file or another book.',
	)
	// B can't see A's book, put A's article in a book of B's, or reuse A's book id.
	const bBook = await b.client.books.create({ id: randomUUID(), title: 'Theirs' })
	expect(await code(b.client.books.get({ id: aBook.id }))).toMatch(/^NOT_FOUND/)
	expect(await code(b.client.books.addChapter({ bookId: bBook.id, readingId: article.id }))).toMatch(/^NOT_FOUND/)
	expect(await code(b.client.books.create({ id: aBook.id, title: 'Taken' }))).toMatch(/^CONFLICT/)
	expect((await b.client.books.list()).map((x) => x.title)).toEqual(['Theirs'])
})
