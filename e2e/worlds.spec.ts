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

test('a lesson logged with + Log is due in Review at once with its cue, Undo takes it back, and Remember this off logs no card', async ({ page }, testInfo) => {
	await joinAs(page)
	await page.goto('/mind')
	await expect(page.getByTestId('mind-due')).toHaveText('0')
	const logLesson = async (text: string, cue?: string, remember = true) => {
		await page.getByRole('button', { name: 'Log a lesson' }).click()
		await dialog(page).getByLabel('What did you learn?').fill(text)
		if (cue) await dialog(page).getByLabel('When does it apply?').fill(cue)
		if (!remember) await dialog(page).getByLabel('Remember this').uncheck()
		await expect(dialog(page).getByLabel('Remember this')).toBeChecked({ checked: remember })
		if (cue) await proof(page, testInfo, 'log-lesson')
		await dialog(page).getByRole('button', { name: 'Save' }).click()
		await expect(dialog(page)).toBeHidden()
	}

	await logLesson('Say a number first and anchor high.', 'Salary talks')
	await expect(page.getByTestId('mind-due')).toHaveText('1')
	await expect(page.getByText("Salary talks: what's the lesson?")).toBeVisible()
	await proof(page, testInfo, 'lesson-due')
	await page.getByRole('status').getByRole('button', { name: 'Undo' }).click()
	await expect(page.getByTestId('mind-due')).toHaveText('0')

	await logLesson('Rest days count as training.', undefined, false)
	await expect(page.getByTestId('entry').filter({ hasText: 'Rest days count as training.' })).toBeVisible()
	await expect(page.getByTestId('mind-due')).toHaveText('0')

	await logLesson('Say a number first and anchor high.', 'Salary talks')
	await expect(page.getByTestId('mind-due')).toHaveText('1')
	await page.getByRole('link', { name: 'Review due ideas' }).click()
	const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
	await expect(page.getByTestId('source')).toHaveText(`Lesson · ${today}`)
	await expect(page.getByTestId('question')).toHaveText("Salary talks: what's the lesson?")
	await page.getByRole('button', { name: 'Show answer' }).click()
	await expect(page.getByTestId('answer')).toContainText('The lessonSay a number first and anchor high.')
	await proof(page, testInfo, 'lesson-in-review')
})

test('a skill: practice logged twice starts the second session from the first one’s Next time, and the skill adds up its minutes this week', async ({ page }, testInfo) => {
	await joinAs(page)
	await page.goto('/mind')
	const mindSkills = page.getByRole('region', { name: 'Skills' })
	await expect(mindSkills).toContainText('Practising something, such as piano or public speaking?')
	await mindSkills.getByRole('link', { name: 'Add a skill' }).click()

	// With no skills yet, the form is open: name, an optional goal and an optional weekly target.
	const add = page.getByRole('form', { name: 'Add skill' })
	await add.getByLabel('Skill').fill('Piano')
	await add.getByLabel('Goal (optional)').fill('Play the Bach prelude at 80 bpm')
	await add.getByLabel('Minutes a week (optional)').fill('120')
	await proof(page, testInfo, 'add-skill')
	await add.getByRole('button', { name: 'Save' }).click()
	const skill = page.getByTestId('skill')
	await expect(skill.getByTestId('skill-week')).toHaveText('0 of 120 min this week · 0 sessions')

	// The first session: the skill is chosen, and a first session starts at 30 minutes.
	await skill.getByRole('button', { name: 'Log practice' }).click()
	await expect(dialog(page).getByRole('radio', { name: 'Practice' })).toBeChecked()
	await expect(dialog(page).getByLabel('Skill')).toHaveValue(await skill.getByRole('link', { name: 'Piano' }).getAttribute('href').then((h) => h!.split('/').at(-1)!))
	await expect(dialog(page).getByLabel('Minutes')).toHaveValue('30')
	await expect(dialog(page).getByLabel('Worked on')).toHaveValue('')
	await dialog(page).getByLabel('Minutes').fill('25')
	await dialog(page).getByLabel('Worked on').fill('Left hand, bars 1 to 8')
	await dialog(page).getByLabel('What told you how it went').fill('A recording: the sixteenths rush')
	await dialog(page).getByLabel('Next time').fill('Even sixteenths at 70 bpm')
	await dialog(page).getByLabel('One thing I learned (optional)').fill('Slow practice finds the uneven notes.')
	await proof(page, testInfo, 'log-practice-first')
	await dialog(page).getByRole('button', { name: 'Save' }).click()
	await expect(dialog(page)).toBeHidden()
	await expect(skill.getByTestId('skill-week')).toHaveText('25 of 120 min this week · 1 session')
	await expect(skill.getByTestId('skill-next')).toHaveText('Next focus: Even sixteenths at 70 bpm')

	// The second session opens on last time's fix and minutes: the focus, feedback and fix loop at zero clicks.
	await skill.getByRole('button', { name: 'Log practice' }).click()
	await expect(dialog(page).getByLabel('Worked on')).toHaveValue('Even sixteenths at 70 bpm')
	await expect(dialog(page).getByLabel('Minutes')).toHaveValue('25')
	await expect(dialog(page).getByText('From last time’s Next time.')).toBeVisible()
	await expect(dialog(page).getByLabel('Next time')).toHaveValue('')
	await proof(page, testInfo, 'log-practice-second')
	await dialog(page).getByLabel('Minutes').fill('20')
	await dialog(page).getByLabel('Next time').fill('Hands together at 70 bpm')
	await dialog(page).getByRole('button', { name: 'Save' }).click()
	await expect(dialog(page)).toBeHidden()
	await expect(skill.getByTestId('skill-week')).toHaveText('45 of 120 min this week · 2 sessions')
	await proof(page, testInfo, 'skills')

	// The skill's page: this week against the target, and the trail of worked on → next time.
	await skill.getByRole('link', { name: 'Piano' }).click()
	await expect(page.getByRole('heading', { name: 'Piano', level: 1 })).toBeVisible()
	await expect(page.getByTestId('skill-week')).toHaveText('45 of 120 min this week · 2 sessions')
	const sessions = page.getByTestId('session')
	await expect(sessions).toHaveCount(2)
	await expect(sessions.first()).toContainText('20 min')
	await expect(sessions.first()).toContainText('Even sixteenths at 70 bpm → next time: Hands together at 70 bpm')
	await expect(sessions.nth(1)).toContainText('Left hand, bars 1 to 8 → next time: Even sixteenths at 70 bpm')
	await expect(sessions.nth(1)).toContainText('How it went: A recording: the sixteenths rush')
	await expect(sessions.nth(1)).toContainText('Learned: Slow practice finds the uneven notes.')
	await proof(page, testInfo, 'skill-page')

	// Mind shows the week, the lesson learned is due in Review, and Progress counts the minutes.
	await page.goto('/mind')
	await expect(mindSkills.getByTestId('mind-skill')).toContainText('45 of 120 min this week · 2 sessions')
	await expect(page.getByText("Practising Piano: what's the lesson?")).toBeVisible()
	await expect(page.getByTestId('entry').filter({ hasText: 'Piano' })).toHaveCount(0)
	await proof(page, testInfo, 'mind-skills')
	await page.goto('/mind/progress')
	await expect(page.getByTestId('practice')).toContainText('Piano45 of 120 min this week')
	await page.getByTestId('practice').scrollIntoViewIfNeeded()
	await proof(page, testInfo, 'progress-practice')

	// + Log → Practice starts on the skill practised last, from its last session.
	await openLog(page)
	await dialog(page).getByRole('radio', { name: 'Practice' }).click()
	await expect(dialog(page).getByLabel('Worked on')).toHaveValue('Hands together at 70 bpm')
	await expect(dialog(page).getByLabel('Minutes')).toHaveValue('20')
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
