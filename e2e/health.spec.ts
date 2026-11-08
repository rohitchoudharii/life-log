import { expect, test } from '@playwright/test'

test('the web app reaches the API and the database', async ({ request }) => {
	const res = await request.post('/rpc/system/health', { headers: { 'x-csrf-token': 'orpc' }, data: {} })
	expect(await res.json()).toEqual({ json: { server: 'ok', database: 'ok' } })
})

test('the API refuses calls without the CSRF header', async ({ request }) => {
	const res = await request.post('/rpc/system/health', { data: {} })
	expect(res.status()).toBe(403)
})
