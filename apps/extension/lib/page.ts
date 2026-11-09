import type { PageSignals } from './preview'

export type PageImage = { src: string; dataUrl: string }
export type ReadPage = { html: string; signals: PageSignals; images: PageImage[] }
export type ReadLimits = { maxImages: number; maxImageBytes: number; maxImagesBytes: number }

/**
 * Reads the page in the member's tab, where they are signed in to the site: its HTML as the
 * browser shows it, how long it is and whether it looks like a preview, and the bytes of its
 * images. Scripts and styles are left out, and every image points at the one address it loads
 * from (lazy-loading placeholders resolved), so the server finds the bytes sent for it. Images on
 * the page's own site are read with its cookies; others only when their site allows it (CORS).
 *
 * chrome.scripting sends only this function's source to the tab, so it imports nothing and
 * defines its helpers inside.
 */
export async function readPage({ maxImages, maxImageBytes, maxImagesBytes }: ReadLimits): Promise<ReadPage> {
	const root = document.querySelector('article') ?? document.querySelector('main') ?? document.body
	const countWords = (text: string | null) => (text ?? '').split(/\s+/).filter(Boolean).length
	const words = Array.from(root.querySelectorAll('p, li, blockquote, pre')).reduce((n, el) => n + countWords(el.textContent), 0)

	const PAYWALL_TEXT = /subscribe (now )?to (read|continue)|already a (subscriber|member)|sign in to (read|continue)|for (paid )?subscribers/i
	const PAYWALL_NAME = /paywall|regwall|meter-?wall/i
	const paywall = Array.from(document.body.querySelectorAll('*')).some((el) => {
		if (!el.getClientRects().length) return false
		if (PAYWALL_NAME.test(`${el.id} ${el.getAttribute('class') ?? ''}`)) return true
		const text = el.textContent ?? ''
		return el.children.length === 0 && text.length <= 300 && PAYWALL_TEXT.test(text)
	})

	let expectedWords: number | null = null
	for (const s of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
		const found = /"wordCount"\s*:\s*"?(\d+)/.exec(s.textContent ?? '')
		if (found) {
			expectedWords = Number(found[1])
			break
		}
	}
	if (!expectedWords) {
		const minutes = /\b(\d{1,3})\s*min(ute)?s?\s+read\b/i.exec(document.body.innerText.slice(0, 20_000))
		if (minutes) expectedWords = Number(minutes[1]) * 230
	}

	const placeholder = (src: string) => !src || /^data:image\/(gif|svg)/i.test(src)
	const largest = (set: string | null) =>
		set
			?.split(',')
			.map((part) => part.trim().split(/\s+/))
			.map(([url, size]) => ({ url, w: parseFloat(size ?? '1') || 1 }))
			.filter((x) => x.url)
			.sort((a, b) => b.w - a.w)[0]?.url ?? null
	const sourceOf = (img: HTMLImageElement) => {
		const current = img.currentSrc || img.getAttribute('src') || ''
		const raw = placeholder(current) ? (img.getAttribute('data-src') ?? largest(img.getAttribute('srcset') ?? img.getAttribute('data-srcset'))) : current
		if (!raw) return null
		try {
			const url = new URL(raw, location.href)
			return /^https?:$/.test(url.protocol) ? url.href : null
		} catch {
			return null
		}
	}

	const clone = document.documentElement.cloneNode(true) as HTMLElement
	const originals = Array.from(document.querySelectorAll('img'))
	const copies = Array.from(clone.querySelectorAll('img'))
	const sources = new Map<HTMLImageElement, string>()
	originals.forEach((img, i) => {
		const copy = copies[i]
		if (!copy) return
		// Drawn at icon size: a logo, an avatar, a share button.
		if (img.complete && img.width && img.height && img.width < 32 && img.height < 32) return copy.remove()
		const src = sourceOf(img)
		for (const name of ['srcset', 'data-src', 'data-srcset', 'loading', 'sizes']) copy.removeAttribute(name)
		if (!src) return
		copy.setAttribute('src', src)
		sources.set(img, src)
	})
	for (const el of Array.from(clone.querySelectorAll('script:not([type="application/ld+json"]), style, noscript, template, link, svg, picture source'))) el.remove()
	const comments = document.createTreeWalker(clone, NodeFilter.SHOW_COMMENT)
	const drop: Node[] = []
	while (comments.nextNode()) drop.push(comments.currentNode)
	for (const c of drop) c.parentNode?.removeChild(c)
	const html = `<!doctype html>${clone.outerHTML}`

	const shrink = async (blob: Blob): Promise<Blob> => {
		try {
			const bitmap = await createImageBitmap(blob)
			const scale = Math.min(1, 1600 / bitmap.width)
			if (scale === 1 && blob.size <= 1024 * 1024) return blob
			const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)))
			canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
			return await canvas.convertToBlob({ type: 'image/webp', quality: 0.85 })
		} catch {
			return blob
		}
	}
	const dataUrl = (blob: Blob) =>
		new Promise<string>((resolve, reject) => {
			const reader = new FileReader()
			reader.onload = () => resolve(reader.result as string)
			reader.onerror = () => reject(reader.error)
			reader.readAsDataURL(blob)
		})
	const fetchImage = async (src: string) => {
		try {
			const sameSite = new URL(src).origin === location.origin
			const res = await fetch(src, sameSite ? { credentials: 'include' } : { mode: 'cors', credentials: 'omit' })
			if (!res.ok) return null
			const blob = await res.blob()
			if (!blob.type.startsWith('image/') || blob.type.includes('svg')) return null
			const small = await shrink(blob)
			return small.size <= maxImageBytes ? small : null
		} catch {
			// The site doesn't allow other sites to read it (no CORS): the server fetches it instead.
			return null
		}
	}

	const wanted = [...new Set(originals.filter((img) => root.contains(img)).flatMap((img) => sources.get(img) ?? []))].slice(0, maxImages)
	const images: PageImage[] = []
	let total = 0
	for (let k = 0; k < wanted.length; k += 4) {
		const batch = await Promise.all(wanted.slice(k, k + 4).map(async (src) => ({ src, blob: await fetchImage(src) })))
		for (const { src, blob } of batch) {
			if (!blob || total + blob.size > maxImagesBytes) continue
			total += blob.size
			images.push({ src, dataUrl: await dataUrl(blob) })
		}
	}
	return { html, signals: { words, paywall, expectedWords }, images }
}
