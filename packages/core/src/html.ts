import type { Block } from './content'

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

/** Text of a subtree without skipped elements, so a script inside a paragraph adds nothing. */
function textOf(n: DomNode): string {
	if (n.nodeType === TEXT) return n.textContent ?? ''
	if (n.nodeType !== ELEMENT || SKIP.has(tag(n))) return ''
	if (tag(n) === 'BR') return '\n'
	return children(n).map(textOf).join('')
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
 * Turns article HTML (as Readability returns it) into our blocks. Only text survives: no markup,
 * attributes, links, or styles, so nothing from the page can run or load when it is shown.
 * Images become image blocks with their source address, for the server to download. A book's
 * own images use its archive's scheme, given in `imageSchemes`.
 */
export function htmlToBlocks(root: DomNode, baseUrl: string, { imageSchemes = WEB }: { imageSchemes?: readonly string[] } = {}): Block[] {
	const out: Block[] = []
	let inline: string[] = []
	let images = 0
	const flush = () => {
		const text = squash(inline.join(''))
		if (text) out.push({ type: 'paragraph', text })
		inline = []
	}
	const image = (n: DomNode) => {
		const src = imageSource(n, baseUrl, imageSchemes)
		if (!src || images >= MAX_IMAGES) return
		images++
		const size = (name: string) => {
			const v = Number(attr(n, name))
			return Number.isInteger(v) && v > 0 ? v : undefined
		}
		out.push({ type: 'image', mediaId: null, alt: squash(attr(n, 'alt')).slice(0, 500), src, width: size('width'), height: size('height') })
	}

	/** Images inside text-only blocks (a list item, a quote), in order, so they are not lost with the markup. */
	const imagesIn = (n: DomNode): DomNode[] =>
		children(n).flatMap((c) => (c.nodeType !== ELEMENT || SKIP.has(tag(c)) ? [] : tag(c) === 'IMG' ? (mathText(c) ? [] : [c]) : imagesIn(c)))

	const walk = (n: DomNode) => {
		for (const c of children(n)) {
			if (c.nodeType === TEXT) {
				inline.push(c.textContent ?? '')
				continue
			}
			if (c.nodeType !== ELEMENT) continue
			const name = tag(c)
			if (SKIP.has(name)) continue
			if (name === 'IMG') {
				// A formula drawn as an image (Wikipedia renders math as SVG) keeps its LaTeX as text.
				const formula = mathText(c)
				if (formula) inline.push(` ${formula} `)
				else {
					flush()
					image(c)
				}
			} else if (INLINE.has(name)) {
				// A linked image (<a><img></a>) is common; anything else inline is just text.
				if (has(c, (el) => tag(el) === 'IMG')) walk(c)
				else inline.push(textOf(c))
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
				const push = () => {
					if (items.length) out.push({ type: 'list', ordered: name === 'OL', items })
					items = []
				}
				for (const li of children(c).filter((x) => x.nodeType === ELEMENT && tag(x) === 'LI')) {
					const text = squash(textOf(li))
					if (text) items.push(text)
					const imgs = imagesIn(li)
					if (imgs.length) {
						push()
						imgs.forEach(image)
					}
				}
				push()
			} else if (name === 'BLOCKQUOTE') {
				flush()
				const text = squash(textOf(c))
				if (text) out.push({ type: 'quote', text })
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
