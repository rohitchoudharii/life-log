import { describe, expect, it } from 'vitest'
import { isPublicAddress, safeFetch } from './fetch'

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
			await expect(safeFetch(url), url).rejects.toThrow('is not a public address')
	})
	it('refuses other schemes and credentials in the link', async () => {
		await expect(safeFetch('file:///etc/passwd')).rejects.toThrow('Only http and https')
		await expect(safeFetch('http://user:pw@example.com/')).rejects.toThrow('username or password')
		await expect(safeFetch('not a url')).rejects.toThrow('not a web address')
	})
})
