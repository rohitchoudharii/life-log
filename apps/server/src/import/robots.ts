import { FetchError, safeFetch } from './fetch'

/** What a site's robots.txt says to Life Log Club: which paths it may fetch, and how long to wait between pages. */
export type Robots = { allows: (url: string) => boolean; crawlDelayMs: number }

type Rule = { allow: boolean; pattern: RegExp; length: number }

const AGENT = 'lifelogclubreader'
const ALLOW_ALL: Robots = { allows: () => true, crawlDelayMs: 0 }

/** A robots.txt path pattern: `*` matches anything, a final `$` the end of the path. */
function patternOf(path: string): RegExp {
	const exact = path.endsWith('$')
	const body = (exact ? path.slice(0, -1) : path)
		.split('*')
		.map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
		.join('.*')
	return new RegExp(`^${body}${exact ? '$' : ''}`)
}

/**
 * Reads robots.txt as RFC 9309 does: the group for our user agent, else the `*` group; the
 * longest matching rule wins, and Allow wins a tie. Crawl-delay, which the RFC leaves out, is
 * read too, because adding a whole book is many fetches from one site.
 */
export function parseRobots(text: string): Robots {
	const groups: { agents: string[]; rules: Rule[]; delay: number }[] = []
	let current: (typeof groups)[number] | undefined
	let lastWasAgent = false
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.replace(/#.*/, '').trim()
		const at = line.indexOf(':')
		if (at < 0) continue
		const key = line.slice(0, at).trim().toLowerCase()
		const value = line.slice(at + 1).trim()
		if (key === 'user-agent') {
			if (!current || !lastWasAgent) groups.push((current = { agents: [], rules: [], delay: 0 }))
			current.agents.push(value.toLowerCase())
			lastWasAgent = true
			continue
		}
		lastWasAgent = false
		if (!current) continue
		if ((key === 'allow' || key === 'disallow') && value)
			current.rules.push({ allow: key === 'allow', pattern: patternOf(value), length: value.length })
		if (key === 'crawl-delay' && Number(value) > 0) current.delay = Number(value) * 1000
	}
	const group = groups.find((g) => g.agents.includes(AGENT)) ?? groups.find((g) => g.agents.includes('*'))
	if (!group) return ALLOW_ALL
	return {
		crawlDelayMs: group.delay,
		allows: (url) => {
			const { pathname, search } = new URL(url)
			const path = pathname + search
			let best: Rule | undefined
			for (const rule of group.rules)
				if (rule.pattern.test(path) && (!best || rule.length > best.length || (rule.length === best.length && rule.allow))) best = rule
			return best?.allow ?? true
		},
	}
}

/**
 * Fetches and reads a site's robots.txt. A site with none (any 4xx) allows everything, as the RFC
 * says. A site whose robots.txt didn't answer throws a FetchError to retry, because the RFC asks
 * a crawler to take that as "disallow everything" for now.
 */
export async function robotsFor(origin: string): Promise<Robots> {
	try {
		const res = await safeFetch(`${origin}/robots.txt`, { accept: 'text/plain', maxBytes: 500 * 1024, timeoutMs: 10_000 })
		return parseRobots(res.body.toString('utf8'))
	} catch (error) {
		if (error instanceof FetchError && !error.retry) return ALLOW_ALL
		throw error
	}
}
