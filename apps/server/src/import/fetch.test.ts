import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isPublicAddress, safeFetch } from './fetch'
import { TEST_SITE, testSite } from './test-site'

const NOT_PUBLIC = 'Life Log Club can only open public web pages.'

describe('isPublicAddress', () => {
	it('allows public IPv4 and IPv6, including IPv4 written as IPv6', () => {
		for (const ip of ['8.8.8.8', '104.20.23.154', '172.66.147.243', '2606:4700::1111', '::ffff:8.8.8.8']) expect(isPublicAddress(ip), ip).toBe(true)
	})
	it('blocks this machine, private networks, link-local, cloud metadata, and special ranges', () => {
		for (const ip of [
			'127.0.0.1', '127.8.9.10', '0.0.0.0', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
			'100.64.0.1', '198.18.0.1', '224.0.0.1', '255.255.255.255', '::', '::1', 'fe80::1', 'fd12:3456::1', 'ff02::1',
			'::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:c0a8:101', '64:ff9b::7f00:1', '2002:7f00:1::', 'not an ip',
		])
			expect(isPublicAddress(ip), ip).toBe(false)
	})
})

describe('safeFetch', () => {
	it('refuses private hosts written as addresses, in any notation, before connecting', async () => {
		for (const url of ['http://127.0.0.1:8787/', 'http://0x7f000001/', 'http://2130706433/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://169.254.169.254/latest/'])
			await expect(safeFetch(url), url).rejects.toThrow(NOT_PUBLIC)
	})
	it('refuses a name that resolves to this machine', async () => {
		await expect(safeFetch('http://localhost:8787/')).rejects.toThrow(NOT_PUBLIC)
	})
	it('refuses other schemes and credentials in the link', async () => {
		await expect(safeFetch('file:///etc/passwd')).rejects.toThrow(NOT_PUBLIC)
		await expect(safeFetch('http://user:pw@example.com/')).rejects.toThrow(NOT_PUBLIC)
		await expect(safeFetch('not a url')).rejects.toThrow("That isn't a web address")
	})

	describe('against the test site', () => {
		const site = testSite()
		beforeAll(() => site.start())
		afterAll(() => site.stop())

		it('fetches an allowed origin', async () => {
			const page = await safeFetch(`${TEST_SITE}/status/200`)
			expect(page.status).toBe(200)
		})
		it('checks every redirect, even from an allowed origin', async () => {
			await expect(safeFetch(`${TEST_SITE}/redirect?to=${encodeURIComponent('http://127.0.0.1:8787/')}`)).rejects.toThrow(NOT_PUBLIC)
			await expect(safeFetch(`${TEST_SITE}/redirect?to=${encodeURIComponent('http://localhost:8787/')}`)).rejects.toThrow(NOT_PUBLIC)
		})
		it('says why a site refused the page, and which refusals are worth retrying', async () => {
			const failure = (path: string) => safeFetch(`${TEST_SITE}${path}`).then(() => null, (e: Error & { retry: boolean }) => [e.message, e.retry])
			expect(await failure('/status/404')).toEqual(["The site says this page doesn't exist (404). Check the link.", false])
			expect(await failure('/status/401')).toEqual([expect.stringContaining('needs you to be signed in'), false])
			expect(await failure('/challenge')).toEqual([expect.stringContaining('blocks automatic reading'), false])
			expect(await failure('/status/503')).toEqual(["The site didn't answer. Try again in a minute.", true])
		})
		it('counts the size after decompression', async () => {
			await expect(safeFetch(`${TEST_SITE}/bomb`, { maxBytes: 1024 * 1024 })).rejects.toThrow('too large')
		})
	})
})
