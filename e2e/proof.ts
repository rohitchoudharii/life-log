import type { Page, TestInfo } from '@playwright/test'

/**
 * Saves a screenshot for an issue's proof file when `PROOF` names the issue, as in
 * `PROOF=issue-10 pnpm e2e e2e/recall.spec.ts`. The file goes to
 * `docs/proof/<issue>/<project>-<name>.png`, so each run at desktop and phone sizes keeps both.
 * Without `PROOF` it does nothing, so tests run as usual.
 */
export async function proof(page: Page, testInfo: TestInfo, name: string) {
	const issue = process.env.PROOF
	if (!issue) return
	// A full-page capture of a scrolled page draws the sticky chrome out of place.
	await page.evaluate(() => window.scrollTo(0, 0))
	// It also draws the phone's fixed bottom bar where the viewport ends, over the page; put it at the page's end.
	const style = 'nav[aria-label="Worlds"].fixed { position: absolute !important; } body { position: relative; }'
	await page.screenshot({ path: `docs/proof/${issue}/${testInfo.project.name}-${name}.png`, fullPage: true, style })
}
