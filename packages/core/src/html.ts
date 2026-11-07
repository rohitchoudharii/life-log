import type { Block, Link } from './content'

/** The few DOM members the converter reads, so any DOM (browser, linkedom, jsdom) works. */
export type DomNode = {
	nodeType: number
	nodeName: string
	childNodes: ArrayLike<DomNode>
	textContent: string | null
	getAttribute?(name: string): string | null
}

const ELEMENT = 1
const TEXT = 3

/** Never content: dropped with everything inside them. */
const SKIP = new Set([
	'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'FRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH', 'CANVAS',
	'VIDEO', 'AUDIO', 'SOURCE', 'TRACK', 'FORM', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'NAV', 'HEAD', 'LINK', 'META', 'BASE',
])
/** Text-level elements: their text joins the paragraph around them. */
const INLINE = new Set([
	'A', 'SPAN', 'EM', 'STRONG', 'B', 'I', 'U', 'S', 'CODE', 'SUB', 'SUP', 'MARK', 'SMALL', 'ABBR', 'TIME', 'Q',
	'CITE', 'KBD', 'SAMP', 'VAR', 'DEL', 'INS', 'LABEL', 'BDI', 'BDO', 'DFN', 'FONT', 'BR', 'WBR',
])
const MAX_IMAGES = 40
/** Pages may embed small images inline; anything else must be a web address the server fetches. */
const DATA_IMAGE = /^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i

const WEB = ['http:', 'https:'] as const

const tag = (n: DomNode) => n.nodeName.toUpperCase()
const attr = (n: DomNode, name: string) => n.getAttribute?.(name) ?? null
const squash = (s: string | null) => (s ?? '').replace(/\s+/g, ' ').trim()
const children = (n: DomNode) => Array.from(n.childNodes)

/** Text with the address it links to, if it is inside a link. */
type Run = { text: string; href: string | null }

/** Where a link goes: an http(s) page other than this one, without its #fragment. */
function linkHref(a: DomNode, baseUrl: string): string | null {
	const raw = attr(a, 'href')?.trim()
	if (!raw) return null
	try {
		const url = new URL(raw, baseUrl)
		if (!(WEB as readonly string[]).includes(url.protocol)) return null
		url.hash = ''
		const base = new URL(baseUrl)
		base.hash = ''
		return url.href === base.href ? null : url.href
	} catch {
		return null
	}
}

/** Text of a subtree without skipped elements, so a script inside a paragraph adds nothing. */
function runsOf(n: DomNode, baseUrl: string, href: string | null = null): Run[] {
	if (n.nodeType === TEXT) return [{ text: n.textContent ?? '', href }]
	if (n.nodeType !== ELEMENT || SKIP.has(tag(n))) return []
	if (tag(n) === 'BR') return [{ text: '\n', href }]
	const inner = tag(n) === 'A' ? (linkHref(n, baseUrl) ?? href) : href
	return children(n).flatMap((c) => runsOf(c, baseUrl, inner))
}

const textOf = (n: DomNode) => runsOf(n, '').map((r) => r.text).join('')

/**
 * Joins runs into one line of text, with whitespace squashed as `squash` does, and the ranges of
 * it that are links. A space between two words of the same link belongs to the link.
 */
function squashRuns(runs: Run[]): { text: string; links: Link[] } {
	let text = ''
	const owner: (string | null)[] = []
	let gap = false
	for (const run of runs)
		for (let i = 0; i < run.text.length; i++) {
			const ch = run.text[i]!
			if (/\s/.test(ch)) {
				gap = true
				continue
			}
			if (gap && text) {
				text += ' '
				owner.push(owner[owner.length - 1] === run.href ? run.href : null)
			}
			gap = false
			text += ch
			owner.push(run.href)
		}
	const links: Link[] = []
	for (let i = 0; i < owner.length; i++) {
		const href = owner[i]
		if (!href) continue
		let end = i + 1
		while (end < owner.length && owner[end] === href) end++
		links.push({ start: i, end, href })
		i = end - 1
	}
	return { text, links }
}

function has(n: DomNode, test: (el: DomNode) => boolean): boolean {
	return children(n).some((c) => c.nodeType === ELEMENT && !SKIP.has(tag(c)) && (test(c) || has(c, test)))
}

/**
 * The address an image loads from: resolved against the page, or a small inline data image.
 * `schemes` are the URL schemes allowed, http and https for web pages.
 */
export function imageSource(n: DomNode, baseUrl: string, schemes: readonly string[] = WEB): string | null {
	const srcset = attr(n, 'srcset') ?? attr(n, 'data-srcset')
	const fromSet = srcset
		?.split(',')
		.map((part) => part.trim().split(/\s+/))
		.map(([url, size]) => ({ url, w: parseFloat(size ?? '1') || 1 }))
		.filter((x) => x.url)
		.sort((a, b) => b.w - a.w)[0]?.url
	const src = attr(n, 'src')
	// Lazy-loading pages put a tiny placeholder in src and the real address in data-src or srcset.
	const placeholder = !src || /^data:image\/(gif|svg)/i.test(src)
	const raw = placeholder ? (attr(n, 'data-src') ?? fromSet ?? null) : src
	if (!raw) return null
	const value = raw.trim()
	if (value.startsWith('data:')) return DATA_IMAGE.test(value) ? value : null
	try {
		const url = new URL(value, baseUrl)
		return schemes.includes(url.protocol) ? url.href : null
	} catch {
		return null
	}
}

/** The LaTeX of a formula image, from its alt text; null for other images. */
function mathText(n: DomNode): string | null {
	const alt = squash(attr(n, 'alt'))
	const isMath = /\bmath\b|mwe-math|\/math\/render\//i.test(`${attr(n, 'class') ?? ''} ${attr(n, 'src') ?? ''}`)
	if (!isMath || !alt) return null
	return alt.replace(/^\{\\displaystyle\s*([\s\S]*)\}$/, '$1').trim()
}

/**
 * Turns article HTML (as Readability returns it) into our blocks. Only text survives, with the
 * addresses its links point at: no markup, attributes, or styles, so nothing from the page can
 * run or load when it is shown.
 * Images become image blocks with their source address, for the server to download. A book's
 * own images use its archive's scheme, given in `imageSchemes`.
 */
export function htmlToBlocks(root: DomNode, baseUrl: string, { imageSchemes = WEB }: { imageSchemes?: readonly string[] } = {}): Block[] {
	const out: Block[] = []
	let inline: Run[] = []
	let images = 0
	const flush = () => {
		const { text, links } = squashRuns(inline)
		if (text) out.push({ type: 'paragraph', text, ...(links.length && { links }) })
		inline = []
	}
	const image = (n: DomNode) => {
		const src = imageSource(n, baseUrl, imageSchemes)
		if (!src || images >= MAX_IMAGES) return
		const size = (name: string) => {
			const v = Number(attr(n, name))
			return Number.isInteger(v) && v > 0 ? v : undefined
		}
		const [width, height] = [size('width'), size('height')]
		// Drawn at icon size (a logo, an avatar, a share button): not part of the article.
		if (width && height && width < 32 && height < 32) return
		images++
		out.push({ type: 'image', mediaId: null, alt: squash(attr(n, 'alt')).slice(0, 500), src, width, height })
	}

	/** Images inside text-only blocks (a list item, a quote), in order, so they are not lost with the markup. */
	const imagesIn = (n: DomNode): DomNode[] =>
		children(n).flatMap((c) => (c.nodeType !== ELEMENT || SKIP.has(tag(c)) ? [] : tag(c) === 'IMG' ? (mathText(c) ? [] : [c]) : imagesIn(c)))

	const walk = (n: DomNode) => {
		for (const c of children(n)) {
			if (c.nodeType === TEXT) {
				inline.push({ text: c.textContent ?? '', href: null })
				continue
			}
			if (c.nodeType !== ELEMENT) continue
			const name = tag(c)
			if (SKIP.has(name)) continue
			if (name === 'IMG') {
				// A formula drawn as an image (Wikipedia renders math as SVG) keeps its LaTeX as text.
				const formula = mathText(c)
				if (formula) inline.push({ text: ` ${formula} `, href: null })
				else {
					flush()
					image(c)
				}
			} else if (INLINE.has(name)) {
				// A linked image (<a><img></a>) is common; anything else inline is just text.
				if (has(c, (el) => tag(el) === 'IMG')) walk(c)
				else inline.push(...runsOf(c, baseUrl))
			} else if (/^H[1-6]$/.test(name)) {
				flush()
				const text = squash(textOf(c))
				if (text) out.push({ type: 'heading', level: Number(name[1]), text })
			} else if (name === 'PRE') {
				flush()
				const text = textOf(c).replace(/^\n+|\s+$/g, '')
				const cls = `${attr(c, 'class') ?? ''} ${children(c).map((x) => attr(x, 'class') ?? '').join(' ')}`
				const language = /(?:language|lang)-([\w+#-]+)/.exec(cls)?.[1]
				if (text) out.push({ type: 'code', text, ...(language && { language }) })
			} else if (name === 'UL' || name === 'OL') {
				flush()
				// An image in an item ends the list there, shows the image, and the list goes on after it.
				let items: string[] = []
				let links: Link[] = []
				const push = () => {
					if (items.length) out.push({ type: 'list', ordered: name === 'OL', items, ...(links.length && { links }) })
					items = []
					links = []
				}
				for (const li of children(c).filter((x) => x.nodeType === ELEMENT && tag(x) === 'LI')) {
					const line = squashRuns(runsOf(li, baseUrl))
					if (line.text) {
						links.push(...line.links.map((l) => ({ ...l, item: items.length })))
						items.push(line.text)
					}
					const imgs = imagesIn(li)
					if (imgs.length) {
						push()
						imgs.forEach(image)
					}
				}
				push()
			} else if (name === 'BLOCKQUOTE') {
				flush()
				const { text, links } = squashRuns(runsOf(c, baseUrl))
				if (text) out.push({ type: 'quote', text, ...(links.length && { links }) })
				imagesIn(c).forEach(image)
			} else if (name === 'TABLE') {
				flush()
				const rows: DomNode[] = []
				const collect = (x: DomNode) => children(x).forEach((y) => (y.nodeType === ELEMENT ? (tag(y) === 'TR' ? rows.push(y) : collect(y)) : null))
				collect(c)
				for (const row of rows) {
					const text = children(row)
						.filter((cell) => cell.nodeType === ELEMENT && /^T[DH]$/.test(tag(cell)))
						.map((cell) => squash(textOf(cell)))
						.join(' | ')
					if (squash(text.replace(/\|/g, ''))) out.push({ type: 'paragraph', text })
				}
			} else if (name === 'HR') {
				flush()
			} else {
				// Containers (div, section, figure, p, li outside a list…): their inline text is one
				// paragraph, and block children become blocks of their own.
				flush()
				walk(c)
				flush()
			}
		}
	}
	walk(root)
	flush()
	return out
}
