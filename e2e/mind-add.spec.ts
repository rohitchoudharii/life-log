import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { ORPCError } from '@orpc/client'
import { expect, type Page, test } from '@playwright/test'
import { newMember } from './api'
import { FAKE_SITE, GOOD_ANTHROPIC_KEY } from './env'
import { blankPdf, testEpub } from '../apps/server/src/import/test-books'
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

	// The text size a member picks is kept for the next reading, in this browser.
	const larger = page.getByRole('group', { name: 'Text size' }).getByRole('button', { name: 'Larger' })
	await larger.click()
	await expect(page.locator('article')).toHaveCSS('font-size', '22.4px')
	await page.reload()
	await expect(larger).toHaveAttribute('aria-pressed', 'true')
	await expect(page.locator('article')).toHaveCSS('font-size', '22.4px')
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
		[`${FAKE_SITE}/books/private/`, "This site asks apps not to copy its pages, so the whole book can't be added. Add one chapter's link instead."],
	]) {
		await addLink(page, url)
		await expect(readings(page).filter({ hasText: url }).getByRole('alert')).toHaveText(message, { timeout: 15_000 })
	}
	// A failed reading can be removed, with Undo.
	const gone = readings(page).filter({ hasText: `${FAKE_SITE}/gone` })
	await gone.getByRole('button', { name: 'Remove' }).click()
	await expect(gone).toHaveCount(0)
	await expect(readings(page)).toHaveCount(4)

	await addLink(page, 'hello world')
	await expect(page.getByRole('status')).toContainText("That isn't a web address. Check the link and try again.")
	await expect(readings(page)).toHaveCount(4)
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

const books = (name: string) => new URL(`../apps/server/src/import/fixtures/${name}`, import.meta.url).pathname
const pickFile = (page: Page, file: string | { name: string; mimeType: string; buffer: Buffer }) =>
	page.getByLabel('EPUB or PDF file').setInputFiles(file)

test('an EPUB added as a file shows as importing, then opens to its chapters', async ({ page, isMobile }) => {
	await joinAs(page)
	await page.goto('/mind')
	await pickFile(page, books('the-prince.epub'))
	await expect(readings(page)).toHaveCount(1)
	await expect(readings(page).getByRole('link', { name: /The Prince/ })).toBeVisible({ timeout: 30_000 })
	await expect(readings(page)).toContainText('Niccolò Machiavelli')

	// The bibliography is not counted: 34 sections to read and recall, of 35.
	await expect(readings(page)).toContainText('34 sections')

	await readings(page).getByRole('link').click()
	await expect(page.getByRole('heading', { level: 1, name: 'The Prince' })).toBeVisible()
	if (isMobile) await page.getByRole('button', { name: /^Contents/ }).click()
	const contents = page.getByRole('navigation', { name: 'Contents' })
	// The book's own outline: the introduction's parts nest under it, and the title page,
	// imprint, dedication, endnotes and colophon are left out.
	await expect(contents.getByRole('listitem')).toHaveText([
		'Introduction',
		'Youth',
		'Office',
		'Literature and Death',
		'The Man and His Works· Reference',
		'The Prince',
		/^I: How Many Kinds/,
		...Array(35 - 7).fill(/./),
	])
	const indent = (name: string) => contents.getByRole('listitem').filter({ hasText: name }).first().evaluate((li) => getComputedStyle(li).paddingLeft)
	expect(await indent('Youth')).not.toBe(await indent('Introduction'))
	await contents.getByRole('button', { name: /The Man and His Works/ }).click()
	await expect(page.getByText('Kept to read. No recall.')).toBeVisible()
	if (isMobile) await page.getByRole('button', { name: /^Contents/ }).click()
	await contents.getByRole('button', { name: 'II: Concerning Hereditary Principalities' }).click()
	await expect(page.getByRole('heading', { level: 2, name: 'II: Concerning Hereditary Principalities' })).toBeVisible()

	// A note opens from its marker in the text, and Esc closes it.
	if (isMobile) await page.getByRole('button', { name: /^Contents/ }).click()
	await contents.getByRole('button', { name: 'III: Concerning Mixed Principalities', exact: true }).click()
	await page.getByRole('button', { name: 'Note 1', exact: true }).click()
	const note = page.getByRole('dialog', { name: 'Note 1' })
	await expect(note).toContainText('Duke Lodovico was Lodovico Moro')
	await page.keyboard.press('Escape')
	await expect(note).toBeHidden()
	await expect(page.getByText('Duke Lodovico was Lodovico Moro')).toHaveCount(0)

	// The same file again is the same reading.
	await page.goto('/mind')
	await pickFile(page, books('the-prince.epub'))
	await expect(page.getByRole('status')).toContainText('You already have this book.')
	await expect(readings(page)).toHaveCount(1)
})

test('a long chapter with no headings gets AI headings when the member opens it, and stays cut by length without a key', async ({ page, isMobile }) => {
	const chapter = 'XIX: That One Should Avoid Being Despised and Hated'
	const contents = page.getByRole('navigation', { name: 'Contents' })
	const openChapter = async () => {
		if (isMobile) await page.getByRole('button', { name: /^Contents/ }).click()
		await contents.getByRole('button', { name: chapter, exact: true }).click()
		await expect(page.getByRole('heading', { level: 2, name: chapter })).toBeVisible()
		if (isMobile) await page.getByRole('button', { name: /^Contents/ }).click()
	}
	await joinAs(page)
	await page.goto('/mind')
	await pickFile(page, books('the-prince.epub'))
	await expect(readings(page).getByRole('link', { name: /The Prince/ })).toBeVisible({ timeout: 30_000 })
	await readings(page).getByRole('link').click()

	await openChapter()
	await expect(contents.getByRole('button', { name: `${chapter} (part 2)` })).toBeVisible()
	await expect(page.getByText('Adding headings to this long chapter…')).toHaveCount(0)

	// Once the member has a key, opening the chapter again adds its headings.
	const saved = await page.request.post('/rpc/ai/saveKey', {
		headers: { 'x-csrf-token': 'orpc' },
		data: { json: { provider: 'anthropic', apiKey: GOOD_ANTHROPIC_KEY } },
	})
	expect(saved.ok()).toBe(true)
	await page.reload()
	await openChapter()
	// e2e/fake-llm.ts puts a heading halfway through; the length cut goes.
	await expect(contents.getByRole('button', { name: 'Where it leads' })).toBeVisible({ timeout: 15_000 })
	await expect(contents.getByRole('button', { name: `${chapter} (part 2)` })).toHaveCount(0)
	// The member stays on the chapter they opened, which now ends where the AI's heading starts.
	await expect(page.getByRole('heading', { level: 2, name: chapter })).toBeVisible()
	await contents.getByRole('button', { name: 'Where it leads' }).click()
	await expect(page.getByText("Heading added by AI. The text is the author's.")).toBeVisible()
})

test('a link to a PDF is read as a book', async ({ page }) => {
	await joinAs(page)
	await page.goto('/mind')
	await addLink(page, `${FAKE_SITE}/opinions/23-719.pdf`)
	await expect(readings(page).getByRole('link', { name: /Trump v. Anderson/ })).toBeVisible({ timeout: 30_000 })
	await readings(page).getByRole('link').click()
	await expect(page.getByText('p. 1', { exact: true })).toBeVisible()
	await expect(page.getByText(/Section 3 of the Fourteenth Amendment/).first()).toBeVisible()
})

test("a link to a web book's contents page adds every chapter page, a batch at a time", async ({ page, isMobile }) => {
	await joinAs(page)
	await page.goto('/mind')
	await addLink(page, `${FAKE_SITE}/books/rings/`)
	// The fake site's 22 pages come 0.4 seconds apart, so the count is there to see.
	await expect(readings(page)).toContainText(/Importing… \d+ of 22 pages/, { timeout: 15_000 })
	await expect(readings(page)).toContainText('The Ring Book')
	await expect(readings(page).getByRole('link', { name: /The Ring Book/ })).toBeVisible({ timeout: 30_000 })
	// Two sections for each of the 21 chapters that came; the missing chapter is not counted.
	await expect(readings(page)).toContainText('42 sections')

	await readings(page).getByRole('link').click()
	await expect(page.getByRole('heading', { level: 1, name: 'The Ring Book' })).toBeVisible()
	await expect(page.getByText('Chapter 1 opens here.', { exact: false })).toBeVisible()
	const contents = page.getByRole('navigation', { name: 'Contents' })
	const open = async (title: string | RegExp) => {
		if (isMobile) await page.getByRole('button', { name: /^Contents/ }).click()
		await contents.getByRole('button', { name: title }).click()
	}
	// Open original goes to the page the section came from.
	await open('2. Hashing keys')
	await expect(page.getByText('Chapter 2 opens here.', { exact: false })).toBeVisible()
	await expect(page.getByRole('link', { name: 'Open original' })).toHaveAttribute('href', `${FAKE_SITE}/books/rings/2.html`)
	await open(/^7\. Replication/)
	await expect(page.getByText("This page couldn't be added: The site says this page doesn't exist (404). Check the link.", { exact: false })).toBeVisible()
	await expect(page.getByRole('link', { name: 'the original page' })).toHaveAttribute('href', `${FAKE_SITE}/books/rings/7.html`)
	await expect(page.getByText('Kept to read. No recall.')).toBeVisible()
	if (isMobile) await page.getByRole('button', { name: /^Contents/ }).click()
	await expect(contents.getByRole('button', { name: '22. What to read next' })).toBeVisible()
})

test('a chapter link adds that chapter, and its card offers the whole book', async ({ page }) => {
	await joinAs(page)
	await page.goto('/mind')
	const chapter = `${FAKE_SITE}/books/rings/3.html`
	await addLink(page, chapter)
	await expect(readings(page).getByRole('link', { name: /3\. Placing servers/ })).toBeVisible({ timeout: 15_000 })
	await expect(readings(page)).toContainText('Part of The Ring Book · 22 pages')
	await readings(page).getByRole('button', { name: 'Add the whole book' }).click()
	// The chapter's card becomes the book's.
	await expect(readings(page)).toHaveCount(1)
	await expect(readings(page)).toContainText(/Importing… \d+ of 22 pages/, { timeout: 15_000 })
	await expect(readings(page).getByRole('link', { name: /The Ring Book/ })).toBeVisible({ timeout: 30_000 })
	await expect(readings(page)).not.toContainText('Add the whole book')
	// The chapter's link now opens the book.
	await addLink(page, chapter)
	await expect(page.getByRole('status')).toContainText('You already have this reading.')
	await expect(page.getByRole('heading', { level: 1, name: 'The Ring Book' })).toBeVisible()
})

test("a book's images are stored and shown in the reader", async ({ page, isMobile }) => {
	await joinAs(page)
	await page.goto('/mind')
	await pickFile(page, { name: 'With a figure.epub', mimeType: 'application/epub+zip', buffer: Buffer.from(testEpub({ 'OEBPS/images/fig.png': readFileSync(books('figure.png')) })) })
	await expect(readings(page).getByRole('link', { name: /Test Book/ })).toBeVisible({ timeout: 30_000 })
	await readings(page).getByRole('link').click()
	if (isMobile) await page.getByRole('button', { name: /^Contents/ }).click()
	await page.getByRole('navigation', { name: 'Contents' }).getByRole('button', { name: 'Chapter Two' }).click()
	const figure = page.getByRole('img', { name: 'Figure' })
	await expect(figure).toBeVisible()
	expect(await figure.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(240)
})

test('a PDF shows its page numbers, and a file that is not a book is refused', async ({ page }) => {
	await joinAs(page)
	await page.goto('/mind')
	await pickFile(page, { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('just some notes') })
	await expect(page.getByRole('status')).toContainText('Life Log Club reads EPUB and PDF files. Choose one of those.')
	await expect(page.getByText('Nothing to read yet.')).toBeVisible()

	await pickFile(page, books('trump-v-anderson.pdf'))
	await expect(readings(page).getByRole('link', { name: /Trump v. Anderson/ })).toBeVisible({ timeout: 30_000 })
	await readings(page).getByRole('link').click()
	await expect(page.getByText('p. 1', { exact: true })).toBeVisible()
})

test('a scanned PDF fails with a message saying so', async ({ page }) => {
	await joinAs(page)
	await page.goto('/mind')
	await pickFile(page, { name: 'scan.pdf', mimeType: 'application/pdf', buffer: Buffer.from(blankPdf()) })
	await expect(readings(page).getByRole('alert')).toHaveText("This PDF is scanned pages without text, so Life Log Club can't read it yet.", { timeout: 30_000 })
	await expect(readings(page).getByRole('button', { name: 'Try again' })).toHaveCount(0)
})
