import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import { BlockList, isIP } from 'node:net'
import zlib from 'node:zlib'
import { env } from '../env'

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


const NOT_PUBLIC = 'Life Log Club can only open public web pages.'
const NO_ANSWER = "The site didn't answer. Try again in a minute."
export const TOO_LARGE = 'This page is too large to add.'

/** A fetch that failed, with a message for the member. `retry` is true when trying again later may work. */
export class FetchError extends Error {
	constructor(
		message: string,
		readonly retry = false,
	) {
		super(message)
	}
}

/**
 * Resolves like dns.lookup, but only to public addresses. The socket connects to exactly the
 * address checked here, so a hostname cannot be re-pointed at a private one in between.
 */
const publicLookup: typeof dnsLookup = ((hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
	dnsLookup(hostname, { ...options, all: true }, (err, addresses: LookupAddress[]) => {
		if (err) return callback(err)
		const ok = addresses.filter((a) => isPublicAddress(a.address))
		if (!ok.length) return callback(new FetchError(NOT_PUBLIC))
		if (options.all) callback(null, ok)
		else callback(null, ok[0]!.address, ok[0]!.family)
	})
}) as typeof dnsLookup

/** Origins tests may reach on this machine, such as the e2e test site. Never set in production. */
const trusted = new Set(env.IMPORT_ALLOWED_ORIGINS)

export type Fetched = { url: string; status: number; contentType: string; headers: http.IncomingHttpHeaders; body: Buffer }

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 LifeLogClubReader/1.0'

function once(url: URL, accept: string, maxBytes: number, signal: AbortSignal): Promise<Fetched & { location?: string }> {
	const host = url.hostname.replace(/^\[|\]$/g, '')
	const allowed = trusted.has(url.origin)
	// An address written as the host is not looked up, so it is checked here.
	if (!allowed && isIP(host) && !isPublicAddress(host)) return Promise.reject(new FetchError(NOT_PUBLIC))
	const lib = url.protocol === 'https:' ? https : http
	return new Promise((resolve, reject) => {
		const req = lib.request(
			url,
			{
				method: 'GET',
				lookup: allowed ? undefined : publicLookup,
				signal,
				headers: { 'user-agent': BROWSER_UA, accept, 'accept-encoding': 'gzip, deflate, br', 'accept-language': 'en' },
			},
			(res) => {
				const status = res.statusCode ?? 0
				const { headers } = res
				if (status >= 300 && status < 400 && headers.location) {
					res.resume()
					return resolve({ url: url.href, status, contentType: '', headers, body: Buffer.alloc(0), location: headers.location })
				}
				const declared = Number(headers['content-length'] ?? 0)
				if (declared > maxBytes) {
					res.destroy()
					return reject(new FetchError(TOO_LARGE))
				}
				const encoding = String(headers['content-encoding'] ?? '').toLowerCase()
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
						reject(new FetchError(TOO_LARGE))
					} else chunks.push(chunk)
				})
				stream.on('end', () => resolve({ url: url.href, status, contentType: String(headers['content-type'] ?? ''), headers, body: Buffer.concat(chunks) }))
				stream.on('error', () => reject(new FetchError(NO_ANSWER, true)))
			},
		)
		req.on('error', (e: Error & { code?: string }) => {
			if (e instanceof FetchError) reject(e)
			else if (e.code === 'ENOTFOUND') reject(new FetchError("That site couldn't be found. Check the link and try again."))
			else reject(new FetchError(NO_ANSWER, true))
		})
		req.end()
	})
}

/** Why a site refused a page, for the member. */
function refused(res: Fetched): FetchError {
	const { status } = res
	if ((status === 401 || status === 403) && res.headers['cf-mitigated'] === 'challenge')
		return new FetchError('This site blocks automatic reading. The Chrome extension will capture it later.')
	if (status === 401 || status === 403) return new FetchError('This page needs you to be signed in. The Chrome extension will capture it later.')
	if (status === 404 || status === 410) return new FetchError(`The site says this page doesn't exist (${status}). Check the link.`)
	if (status === 429 || status >= 500) return new FetchError(NO_ANSWER, true)
	return new FetchError(`The site refused to send this page (${status}). Try again later.`)
}

/**
 * Fetches a URL for a member: http and https only, public addresses only (checked again on every
 * redirect and at connect time), at most `maxBytes` after decompression, within `timeoutMs`
 * overall. Every failure is a FetchError whose message the member can read.
 */
export async function safeFetch(
	input: string,
	{ accept = '*/*', maxBytes = 5 * 1024 * 1024, timeoutMs = 20_000 }: { accept?: string; maxBytes?: number; timeoutMs?: number } = {},
): Promise<Fetched> {
	const signal = AbortSignal.timeout(timeoutMs)
	let url: URL
	try {
		url = new URL(input)
	} catch {
		throw new FetchError("That isn't a web address. Check the link and try again.")
	}
	for (let hop = 0; hop <= 5; hop++) {
		if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new FetchError(NOT_PUBLIC)
		if (url.username || url.password) throw new FetchError(NOT_PUBLIC)
		const res = await once(url, accept, maxBytes, signal)
		if (!res.location) {
			if (res.status >= 400) throw refused(res)
			return res
		}
		url = new URL(res.location, url)
	}
	throw new FetchError('This link redirects too many times. Open it in your browser and add the address it ends on.')
}
