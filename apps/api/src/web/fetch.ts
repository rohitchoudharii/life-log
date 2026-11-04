import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import { BlockList, isIP } from 'node:net'
import zlib from 'node:zlib'

/** Addresses a fetch on a user's behalf must never reach: this machine, private networks, and special ranges. */
const blocked = new BlockList()
for (const [net, prefix] of [
	['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
	['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
	['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const)
	blocked.addSubnet(net, prefix, 'ipv4')
for (const [net, prefix] of [
	['::', 127], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23],
	['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const)
	blocked.addSubnet(net, prefix, 'ipv6')

/** ::ffff:7f00:1 is 127.0.0.1. (A ::ffff:0:0/96 rule would not work: BlockList matches it against every IPv4 address.) */
function unmapped(ip: string): string {
	const m = /^::ffff:(?:([0-9a-f]{1,4}):([0-9a-f]{1,4})|(\d+\.\d+\.\d+\.\d+))$/i.exec(ip)
	if (!m) return ip
	if (m[3]) return m[3]
	const hi = parseInt(m[1]!, 16)
	const lo = parseInt(m[2]!, 16)
	return [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.')
}

export function isPublicAddress(address: string): boolean {
	const ip = unmapped(address)
	const family = isIP(ip)
	return family !== 0 && !blocked.check(ip, family === 4 ? 'ipv4' : 'ipv6')
}

export class FetchError extends Error {}

/**
 * Resolves like dns.lookup, but only to public addresses. The socket connects to exactly the
 * address checked here, so a hostname cannot be re-pointed at a private one in between.
 */
const publicLookup: typeof dnsLookup = ((hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
	dnsLookup(hostname, { ...options, all: true }, (err, addresses: LookupAddress[]) => {
		if (err) return callback(err)
		const ok = addresses.filter((a) => isPublicAddress(a.address))
		if (!ok.length) return callback(new FetchError(`${hostname} is not a public address`))
		if (options.all) callback(null, ok)
		else callback(null, ok[0]!.address, ok[0]!.family)
	})
}) as typeof dnsLookup

export type Fetched = { url: string; status: number; contentType: string; body: Buffer }

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 PeakReader/1.0'

function once(url: URL, accept: string, maxBytes: number, signal: AbortSignal, referer?: string): Promise<Fetched & { location?: string }> {
	const host = url.hostname.replace(/^\[|\]$/g, '')
	// An address written as the host is not looked up, so it is checked here.
	if (isIP(host) && !isPublicAddress(host)) return Promise.reject(new FetchError(`${host} is not a public address`))
	const lib = url.protocol === 'https:' ? https : http
	return new Promise((resolve, reject) => {
		const req = lib.request(
			url,
			{
				method: 'GET',
				lookup: publicLookup,
				signal,
				headers: { 'user-agent': BROWSER_UA, accept, 'accept-encoding': 'gzip, deflate, br', 'accept-language': 'en', ...(referer && { referer }) },
			},
			(res) => {
				const status = res.statusCode ?? 0
				if (status >= 300 && status < 400 && res.headers.location) {
					res.resume()
					return resolve({ url: url.href, status, contentType: '', body: Buffer.alloc(0), location: res.headers.location })
				}
				const declared = Number(res.headers['content-length'] ?? 0)
				if (declared > maxBytes) {
					res.destroy()
					return reject(new FetchError('That page is too large'))
				}
				const encoding = String(res.headers['content-encoding'] ?? '').toLowerCase()
				// Limits count bytes after decompression, so a small compressed bomb cannot get through.
				const stream =
					encoding === 'gzip' ? res.pipe(zlib.createGunzip()) : encoding === 'br' ? res.pipe(zlib.createBrotliDecompress()) : encoding === 'deflate' ? res.pipe(zlib.createInflate()) : res
				const chunks: Buffer[] = []
				let size = 0
				stream.on('data', (chunk: Buffer) => {
					size += chunk.length
					if (size > maxBytes) {
						res.destroy()
						stream.destroy()
						reject(new FetchError('That page is too large'))
					} else chunks.push(chunk)
				})
				stream.on('end', () => resolve({ url: url.href, status, contentType: String(res.headers['content-type'] ?? ''), body: Buffer.concat(chunks) }))
				stream.on('error', (e) => reject(new FetchError(`Could not read the response: ${e.message}`)))
			},
		)
		req.on('error', (e) => reject(e instanceof FetchError ? e : new FetchError(e.name === 'AbortError' ? 'The site took too long to answer' : `Could not reach the site: ${e.message}`)))
		req.end()
	})
}

/**
 * Fetches a URL for a user: http and https only, public addresses only (checked again on every
 * redirect), at most `maxBytes`, within `timeoutMs` overall.
 */
export async function safeFetch(
	input: string,
	{ accept = '*/*', maxBytes = 5 * 1024 * 1024, timeoutMs = 15_000, referer }: { accept?: string; maxBytes?: number; timeoutMs?: number; referer?: string } = {},
): Promise<Fetched> {
	const signal = AbortSignal.timeout(timeoutMs)
	let url: URL
	try {
		url = new URL(input)
	} catch {
		throw new FetchError('That is not a web address')
	}
	for (let hop = 0; hop <= 5; hop++) {
		if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new FetchError('Only http and https links can be added')
		if (url.username || url.password) throw new FetchError('Links with a username or password cannot be added')
		const res = await once(url, accept, maxBytes, signal, referer)
		if (!res.location) {
			if (res.status >= 400) throw new FetchError(`The site answered ${res.status}`)
			return res
		}
		url = new URL(res.location, url)
	}
	throw new FetchError('Too many redirects')
}
