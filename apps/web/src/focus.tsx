import { type Block, blockText, countWords } from '@life-log-club/domain'
import { type RefObject, useEffect, useMemo, useRef, useState } from 'react'
import { useToast } from './toast'

/** How far below the top of the window the text starts, under the sticky header. */
export const TOP = 80

/**
 * The reading aids, one at a time, each for a different way focus slips: where the eye is, how
 * fast it goes, how the text is laid out, which sense reads it, and noticing a drift. Each comes
 * with the line the reading settings show under it.
 */
export const FOCUS_AIDS = {
	Off: 'The text as it is.',
	'Focus line': 'Dims all but the line you are on. Move the pointer or press ↑ and ↓; on a phone, scroll the text through it.',
	Pacer: 'A guide moves through the text at your speed. Space starts and stops it; tap a word to start there.',
	Phrases: 'One phrase per line. Each new sentence starts at the edge.',
	'Read aloud': 'Your device reads the text and marks each word as it says it. Tap a word to start there.',
	'Drift check': 'About every minute of text, asks if you are still with it, and takes you back if not.',
}
export type FocusAid = keyof typeof FOCUS_AIDS

/**
 * How the Pacer guides the eye, each with the line the reading settings show under it. The guide
 * sets the pace and the eyes stay on the words, so each line says where to read.
 */
export const PACER_STYLES = {
	'Steady line': 'A line moves under each line of text at one even speed, set by how many words it has. Keep your eyes on the words and let it set the pace.',
	Fingertip: 'A line moves like a fingertip, easing a little over hard words and into commas. Keep your eyes on the words.',
	Lamp: 'The words around your place stay dark and the rest soften, quicker over small words and slower over hard ones. Read near the front of the dark part.',
	'Line lamp': 'The line you are on stays dark and the lines around it soften, with a steady line under it.',
}
export type PacerStyle = keyof typeof PACER_STYLES

export const FOCUS_LINES = { '1 line': '1', '3 lines': '3' }
export type FocusLines = keyof typeof FOCUS_LINES
/**
 * Pacer speeds, in words a minute: 160 to 320 in even steps of 10, so − and + make small changes
 * a member can feel. It starts slow: going faster than your own speed costs understanding.
 */
const PACE_ORDER = Array.from({ length: 17 }, (_, i) => String(160 + i * 10))
export const PACES: Record<string, string> = Object.fromEntries(PACE_ORDER.map((p) => [p, p]))
export type Pace = string
/** Read aloud speeds, as rates of the voice: 0.75× to 3× in steps of 0.05, written like '0.8' and '1'. */
const RATE_ORDER = Array.from({ length: 46 }, (_, i) => String((75 + i * 5) / 100))
export const RATES: Record<string, string> = Object.fromEntries(RATE_ORDER.map((r) => [r, r]))
export type Rate = string
/** Words a minute of a voice at 1×. Voices differ, so this is a typical speed, not a measured one. */
const VOICE_WPM = 165

const JOINERS = new Set(['and', 'but', 'or', 'nor', 'yet', 'so', 'because', 'which', 'who', 'whom', 'whose', 'where', 'when', 'while', 'whereas', 'if', 'unless', 'until', 'although', 'though', 'since', 'than', 'before', 'after'])
const PREPOSITIONS = new Set(['in', 'on', 'at', 'for', 'with', 'from', 'by', 'about', 'into', 'onto', 'through', 'over', 'under', 'between', 'among', 'without', 'within', 'across', 'toward', 'towards', 'against', 'during', 'like'])
const SENTENCE_END = /[.?!…]["'”’)\]]*$/
const PAUSE = /[,;:]["'”’)\]]*$|[—–]$/

/**
 * Where a text's phrases start, for setting it one phrase per line: at each new sentence, after a
 * comma or other pause, and before a joining word or a preposition once the phrase has a few words.
 * A break never leaves one word alone at the end of a sentence. `sentence` marks a phrase that
 * starts a sentence. This follows the punctuation and common words, not a parse of the grammar.
 */
export function phraseStarts(text: string) {
	const tokens = [...text.matchAll(/\S+/g)].map((m) => ({ at: m.index, word: m[0] }))
	const starts: { at: number; sentence: boolean }[] = []
	let words = 0
	tokens.forEach((t, i) => {
		const prev = tokens[i - 1]
		if (!prev) return void (words = 1)
		let left = 0
		for (let j = i; j < tokens.length; j++) {
			left++
			if (SENTENCE_END.test(tokens[j]!.word)) break
		}
		const bare = t.word.toLowerCase().replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '')
		const sentence = SENTENCE_END.test(prev.word)
		const cut =
			sentence ||
			(left >= 2 && ((PAUSE.test(prev.word) && words >= 2) || (JOINERS.has(bare) && words >= 3) || (PREPOSITIONS.has(bare) && words >= 4)))
		if (cut) {
			starts.push({ at: t.at, sentence })
			words = 1
		} else words++
	})
	return starts
}

type Word = { node: Text; start: number; end: number; block: number }

/** The words of the blocks in `root`, in reading order, without note markers, code, tables or figures. */
function textWords(root: HTMLElement) {
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
		acceptNode: (n) =>
			n.parentElement?.closest('[data-block]') && !n.parentElement.closest('sup, pre, table, figure') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
	})
	const words: Word[] = []
	while (walker.nextNode()) {
		const node = walker.currentNode as Text
		const block = Number(node.parentElement?.closest('[data-block]')?.getAttribute('data-block'))
		for (const m of node.data.matchAll(/\S+/g)) words.push({ node, start: m.index, end: m.index + m[0].length, block })
	}
	return words
}

const wordRange = (w: Word) => {
	const range = new Range()
	range.setStart(w.node, w.start)
	range.setEnd(w.node, w.end)
	return range
}
const wordText = (w: Word) => w.node.data.slice(w.start, w.end)

/** Keeps a rectangle in the calm upper part of the screen, under the header. */
function keepInView(rect: DOMRect) {
	if (rect.bottom > window.innerHeight * 0.7 || rect.top < TOP) window.scrollBy({ top: rect.top - (TOP + (window.innerHeight - TOP) * 0.3), behavior: 'smooth' })
}

/** Marks one word with the `focus-word` highlight (styles.css), without touching the text itself. */
function markWord(w: Word | null) {
	if (!('highlights' in CSS)) return
	if (!w) return void CSS.highlights.delete('focus-word')
	const range = wordRange(w)
	CSS.highlights.set('focus-word', new Highlight(range))
	keepInView(range.getBoundingClientRect())
}

type Line = { top: number; bottom: number }

/** The lines of text in `root`, top to bottom, measured from the top of `root`. */
function measureLines(root: HTMLElement) {
	const top = root.getBoundingClientRect().top
	const rects: Line[] = []
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
		acceptNode: (n) => (n.parentElement?.closest('[data-block]') && n.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
	})
	const range = new Range()
	while (walker.nextNode()) {
		range.selectNodeContents(walker.currentNode)
		for (const r of range.getClientRects()) if (r.width > 0) rects.push({ top: r.top - top, bottom: r.bottom - top })
	}
	rects.sort((a, b) => a.top - b.top)
	// Pieces of one line overlap in height, even when a link or a note marker sits a little higher.
	const lines: Line[] = []
	for (const r of rects) {
		const last = lines.at(-1)
		if (last && r.top < last.bottom - 2) last.bottom = Math.max(last.bottom, r.bottom)
		else lines.push({ ...r })
	}
	return lines
}

/**
 * Focus line: dims the text in `root` above and below the line in focus (`span` lines, 1 or 3).
 * The line in focus is the one at a height on screen that follows the mouse, a tap, or ↑ and ↓;
 * scrolling moves the text through it, so on a phone it works like a reading ruler.
 */
export function FocusLine({ root, span }: { root: RefObject<HTMLElement | null>; span: number }) {
	const [band, setBand] = useState<Line | null>(null)
	useEffect(() => {
		const el = root.current
		if (!el) return
		let lines: Line[] = []
		let cur = 0
		let anchor = TOP + (window.innerHeight - TOP) * 0.3
		let frame = 0
		const clamp = (i: number) => Math.max(0, Math.min(lines.length - 1, i))
		const place = () => {
			const half = (span - 1) / 2
			const a = lines[clamp(cur - half)]
			const b = lines[clamp(cur + half)]
			setBand(a && b ? { top: a.top, bottom: b.bottom } : null)
		}
		const follow = () => {
			const y = anchor - el.getBoundingClientRect().top
			let best = Infinity
			lines.forEach((l, i) => {
				const d = y < l.top ? l.top - y : y > l.bottom ? y - l.bottom : 0
				if (d < best) {
					best = d
					cur = i
				}
			})
			place()
		}
		const measure = () => {
			cancelAnimationFrame(frame)
			frame = requestAnimationFrame(() => {
				lines = measureLines(el)
				follow()
			})
		}
		const onMove = (e: PointerEvent) => {
			if (e.pointerType !== 'mouse') return
			anchor = e.clientY
			follow()
		}
		const onTap = (e: PointerEvent) => {
			if (e.pointerType === 'mouse') return
			anchor = e.clientY
			follow()
		}
		const onKey = (e: KeyboardEvent) => {
			if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return
			if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"], dialog, [role="menu"]')) return
			const step = { ArrowDown: 1, j: 1, ArrowUp: -1, k: -1 }[e.key]
			if (!step || !lines.length) return
			e.preventDefault()
			cur = clamp(cur + step)
			place()
			const line = lines[cur]!
			const y = el.getBoundingClientRect().top + (line.top + line.bottom) / 2
			const calm = TOP + (window.innerHeight - TOP) * 0.3
			if (y > window.innerHeight * 0.7 || y < TOP + 16) {
				anchor = calm
				window.scrollBy({ top: y - calm, behavior: 'smooth' })
			} else anchor = y
		}
		measure()
		const resized = new ResizeObserver(measure)
		resized.observe(el)
		// Words worth knowing and headings can arrive after the text, and split or move its lines.
		const changed = new MutationObserver(measure)
		changed.observe(el, { childList: true, subtree: true, characterData: true })
		el.addEventListener('pointermove', onMove)
		el.addEventListener('pointerdown', onTap)
		window.addEventListener('scroll', follow, { passive: true })
		window.addEventListener('keydown', onKey)
		return () => {
			cancelAnimationFrame(frame)
			resized.disconnect()
			changed.disconnect()
			el.removeEventListener('pointermove', onMove)
			el.removeEventListener('pointerdown', onTap)
			window.removeEventListener('scroll', follow)
			window.removeEventListener('keydown', onKey)
		}
	}, [root, span])
	if (!band) return null
	const mask = 'pointer-events-none absolute -inset-x-4 z-10 bg-world/85 transition-[top,height] duration-150'
	return (
		<>
			<div aria-hidden data-focus-line className={`${mask} top-0`} style={{ height: Math.max(0, band.top - 3) }} />
			<div aria-hidden className={`${mask} bottom-0`} style={{ top: band.bottom + 3 }} />
			<div
				aria-hidden
				className="pointer-events-none absolute -left-3 z-10 w-[3px] rounded-full bg-world-accent transition-[top,height] duration-150"
				style={{ top: band.top + 2, height: Math.max(0, band.bottom - band.top - 4) }}
			/>
		</>
	)
}

/**
 * The voice the device has for the page's language, preferring one on the device, which reports
 * each word it says. Only looked for when `on`, since voices load late and would restart the Pacer.
 */
function useVoice(on: boolean) {
	const [voice, setVoice] = useState<SpeechSynthesisVoice | null>(null)
	useEffect(() => {
		if (!on || !('speechSynthesis' in window)) return
		const lang = (document.documentElement.lang || navigator.language || 'en').slice(0, 2).toLowerCase()
		const pick = () => {
			const voices = speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith(lang))
			setVoice(voices.find((v) => v.localService && v.default) ?? voices.find((v) => v.localService) ?? voices[0] ?? null)
		}
		pick()
		speechSynthesis.addEventListener('voiceschanged', pick)
		return () => speechSynthesis.removeEventListener('voiceschanged', pick)
	}, [on])
	return voice
}

/**
 * The most common English function words. Eyes skip most of them, so the mark moves on quickly.
 * Negations (not, no, never) are left out on purpose: missing one flips the meaning.
 */
const LIGHT = new Set(
	`the a an and or but nor so yet of to in on at by for from with without as into onto upon than then that this these those there here it its it's is are was were be been being am do does did done have has had will would can could shall should may might must i me my mine we us our you your he him his she her they them their who whom whose which what when where why how if up out off about over under after before while because though all some any each both few many much more most such only own same too very just also even still again ever i'm you're we're they're that's don't doesn't didn't can't won't isn't aren't wasn't let's`.split(' '),
)
/** A period that ends an abbreviation or an initial, not a sentence. */
const ABBREVIATION = /^(?:dr|mr|mrs|ms|prof|st|vs|e\.g|i\.e|\p{L})\.$/iu
const endsSentence = (text: string) => SENTENCE_END.test(text) && !ABBREVIATION.test(text.replace(/^[^\p{L}]+/u, ''))

/** Vowel groups, less a silent final e: rough, but enough to tell a hard word from an easy one. */
function syllables(letters: string) {
	const groups = letters.match(/[aeiouy]+/g)?.length ?? 0
	return Math.max(1, groups - (groups > 1 && /[^l]e$/.test(letters) ? 1 : 0))
}

/**
 * How long a word takes to read, in beats of an average word: short function words about half,
 * long words, words of many syllables, numbers, acronyms, names and odd spellings more, up to 2.4.
 * `first` is a word that starts a sentence, where a capital says nothing about a name.
 */
function weight(text: string, first: boolean) {
	const bare = text.replace(/[‘’]/g, "'").replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
	const lower = bare.toLowerCase()
	if (LIGHT.has(lower)) return lower.length <= 3 ? 0.5 : 0.55
	const letters = lower.replace(/[^\p{L}]/gu, '')
	let w = 0.75 + 0.05 * Math.min(lower.replace(/[^\p{L}\p{N}]/gu, '').length, 16) + 0.12 * Math.max(0, syllables(letters) - 2)
	if (/\d/.test(bare)) w *= 1.4
	else if (/^\p{Lu}{2,}$/u.test(bare)) w *= 1.3
	else if (!first && /^\p{Lu}/u.test(bare)) w *= 1.15
	if (/\p{L}-\p{L}/u.test(bare)) w *= 1.15
	if (/q(?!u)|\B[xzy]\B|ph|[bcdfghjklmnpqrstvwxz]{4}|[^\x00-\x7f]/.test(letters)) w *= 1.15
	if (letters.length >= 13) w *= 1.1
	return Math.min(2.4, Math.max(0.45, w))
}

/** The rest after a word, in beats: the largest that applies, from a comma's to a heading's. */
function rest(w: Word, next: Word | undefined): number {
	const text = wordText(w)
	if (next && next.block !== w.block) return w.node.parentElement?.closest('h1, h2, h3, h4, h5, h6') ? 2 : 1.6
	if (endsSentence(text)) return 0.9
	if (/[;:][\"'”’)\]]*$|[—–]$/.test(text)) return 0.5
	if (/,[\"'”’)\]]*$|[\"”’)\]]$/.test(text)) return 0.3
	return 0
}

/**
 * The beats each word of `all` takes, as time on the word and a rest after it, scaled so that the
 * whole text averages one beat a word, rests included. So the speed a member picks stays the true
 * average: small words go faster and hard ones slower, but the text takes as long as it should.
 */
function timeline(all: Word[]) {
	const word = all.map((w, i) => weight(wordText(w), !all[i - 1] || all[i - 1]!.block !== w.block || endsSentence(wordText(all[i - 1]!))))
	const pause = all.map((w, i) => rest(w, all[i + 1]))
	const k = all.length / (word.reduce((a, b) => a + b, 0) + pause.reduce((a, b) => a + b, 0) || 1)
	return { word: word.map((b) => b * k), rest: pause.map((b) => b * k) }
}

/**
 * The beats for the line styles: every word one beat, so a line takes (60 / pace) × its words and
 * the guide crosses it at one speed, with no change of pace inside a line or between like lines.
 * Only the end of a paragraph or heading rests, 1.5 beats, so the guide does not run straight on.
 */
function evenTimeline(all: Word[]) {
	return { word: all.map(() => 1), rest: all.map((w, i) => (all[i + 1] && all[i + 1]!.block !== w.block ? 1.5 : 0)) }
}

/** Where the sentence that word `i` is in starts. */
function sentenceStart(all: Word[], i: number) {
	while (i > 0 && all[i - 1]!.block === all[i]!.block && !endsSentence(wordText(all[i - 1]!))) i--
	return i
}

/**
 * A smooth path through points (t, x) that never turns back, as a fingertip draws it: a monotone
 * cubic, which slows between points far apart in time without stopping or overshooting. Past the
 * ends it goes straight on at the end's speed.
 */
function monotone(ts: number[], xs: number[]) {
	const n = ts.length
	const h = ts.slice(1).map((t, k) => t - ts[k]!)
	const d = h.map((hk, k) => (xs[k + 1]! - xs[k]!) / hk)
	const m = xs.map((_, k) => {
		if (k === 0) return d[0]!
		if (k === n - 1) return d[k - 1]!
		const [a, b] = [d[k - 1]!, d[k]!]
		if (a * b <= 0) return 0
		const [w1, w2] = [2 * h[k]! + h[k - 1]!, h[k]! + 2 * h[k - 1]!]
		return (w1 + w2) / (w1 / a + w2 / b)
	})
	return (t: number) => {
		if (t <= ts[0]!) return xs[0]! + m[0]! * (t - ts[0]!)
		if (t >= ts[n - 1]!) return xs[n - 1]! + m[n - 1]! * (t - ts[n - 1]!)
		let k = 0
		while (k < n - 2 && ts[k + 1]! <= t) k++
		const s = (t - ts[k]!) / h[k]!
		const [s2, s3] = [s * s, s * s * s]
		return (2 * s3 - 3 * s2 + 1) * xs[k]! + (s3 - 2 * s2 + s) * h[k]! * m[k]! + (-2 * s3 + 3 * s2) * xs[k + 1]! + (s3 - s2) * h[k]! * m[k + 1]!
	}
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
const smooth = (v: number) => clamp01(v) ** 2 * (3 - 2 * clamp01(v))
/**
 * How far ahead of the reading point the line runs, in time: it shows where the reading will be
 * this much later, so it leads the eye on, and it still reaches the end of a line just before the
 * reader and goes straight on to the next.
 */
const LEAD_MS = 250
/**
 * How long the guide eases in at the start of each line, and how slowly it starts: the eye needs a
 * moment after its sweep back to find the first words, so the guide waits for it there.
 */
const SETTLE_MS = 1000
const SETTLE_SPEED = 0.2

/**
 * Progress through a line `p` (0 to 1 of its time) as progress across it: it starts at
 * SETTLE_SPEED of full speed, rises smoothly to full speed over the first `r` of the line, then goes
 * on evenly. The rest of the line goes a little faster to make up for it, so the line still ends on
 * time and the pace stays true.
 */
function settle(p: number, r: number) {
	const a = SETTLE_SPEED
	const v = 1 / (1 - (r * (1 - a)) / 2)
	if (p <= 0) return v * a * p
	if (p < r) {
		const u = p / r
		return v * (a * p + (1 - a) * r * (u ** 3 - u ** 4 / 2))
	}
	return v * (a * r + ((1 - a) * r) / 2 + p - r)
}
/** How dark the lamps leave the text away from the reader's place, as a share of full ink; matches styles.css. */
const LAMP_FLOOR = 0.55

/**
 * The Pacer, from word `from` of `words()` at `pace` words a minute, until the text ends; returns
 * what stops it. Each word gets its share of time from `timeline`, and the guide moves by line, not
 * by word: the lines (`bars`, two so one can leave as the next comes in) cross each line of text at
 * a speed set by that line's words, and the lamps shade the text around the reader's place with the
 * `pacer-0` to `pacer-10` highlights (styles.css). A fresh start holds a moment and eases up to
 * speed over 8 words; one `resumed` after a short stop picks up quicker.
 */
function runPacer({
	el,
	words,
	from,
	style,
	pace,
	resumed,
	bars,
	onWord,
	onEnd,
}: {
	el: HTMLElement
	words: () => Word[]
	from: number
	style: PacerStyle
	pace: number
	resumed: boolean
	bars: HTMLElement[]
	onWord: (i: number) => void
	onEnd: () => void
}) {
	const beat = 60_000 / pace
	const lined = style !== 'Lamp'
	// The guide glides even when the device asks for reduced motion: the member starts it, it moves
	// slowly within the text, and stepping from word to word is the jumpiness the Pacer is there to avoid.
	const lamp = (style === 'Lamp' || style === 'Line lamp') && 'highlights' in CSS
	const width = bars[0]?.offsetWidth ?? 0
	// A line left from another style, or from before a pause, has no place under the Lamp.
	if (!lined) for (const b of bars) b.style.opacity = '0'
	let all = words()
	// The line styles time each line by its words; Fingertip and Lamp weight each word.
	const timing = style === 'Steady line' || style === 'Line lamp' ? evenTimeline : timeline
	let plan = timing(all)
	let first = from
	let i = from

	// When each word from `first` on starts, and how long the guide is on it. `schedule` plans from
	// word `j0`, starting at `t`, and keeps the times of the words before it.
	const starts: number[] = []
	const lengths: number[] = []
	let end = 0
	const schedule = (j0: number, t: number, ramp: number, slow: number) => {
		starts.length = lengths.length = all.length
		for (let j = j0; j < all.length; j++) {
			const speed = j - j0 < ramp ? slow + ((1 - slow) * (j - j0)) / ramp : 1
			starts[j] = t
			lengths[j] = Math.max(90, (beat * plan.word[j]!) / speed)
			t += lengths[j]! + (beat * plan.rest[j]!) / speed
		}
		end = t
	}
	if (resumed) schedule(first, performance.now() + 250, 4, 0.85)
	else schedule(first, performance.now() + 400, 8, 0.7)

	// Where words and lines sit in the text, measured as needed; they only change when the text reflows.
	let spots = new Map<number, DOMRect>()
	let lines = new Map<number, { a: number; z: number }>()
	let paths = new Map<number, (t: number) => number>()
	const slots = new Map<number, HTMLElement>()
	let turn = 0
	const forget = () => {
		spots = new Map()
		lines = new Map()
		paths = new Map()
		slots.clear()
	}
	const spot = (j: number) => {
		let r = spots.get(j)
		if (!r) {
			const w = wordRange(all[j]!).getClientRects()[0] ?? new DOMRect()
			const o = el.getBoundingClientRect()
			r = new DOMRect(w.left - o.left, w.top - o.top, w.width, w.height)
			spots.set(j, r)
		}
		return r
	}
	const sameLine = (a: number, c: number) => !!all[a] && !!all[c] && all[a]!.block === all[c]!.block && Math.abs(spot(a).top - spot(c).top) < spot(a).height / 2
	const lineOf = (j: number) => {
		let l = lines.get(j)
		if (!l) {
			let [a, z] = [j, j]
			while (a > first && sameLine(a - 1, a)) a--
			while (sameLine(z, z + 1)) z++
			l = { a, z }
			for (let k = a; k <= z; k++) lines.set(k, l)
		}
		return l
	}
	/** A line of text on screen and in time. A paragraph's last line ends with its last word, before the rest. */
	const span = (j: number) => {
		const { a, z } = lineOf(j)
		const next = all[z + 1]
		const to = next && next.block === all[z]!.block ? starts[z + 1]! : starts[z]! + lengths[z]!
		return { a, z, left: spot(a).left, right: spot(z).right, bottom: Math.max(spot(a).bottom, spot(z).bottom), from: starts[a]!, to }
	}
	type Span = ReturnType<typeof span>
	// One speed across the line: the words' weights set how long the line takes, not the speed inside it.
	const steady = (s: Span, t: number) => s.left + ((s.right - s.left) * (t - s.from)) / (s.to - s.from)
	// Through each word's start, half way between its own time and the steady line's, so it slows but never stops.
	const finger = (s: Span, t: number) => {
		let path = paths.get(s.a)
		if (!path) {
			const [ts, xs] = [[] as number[], [] as number[]]
			for (let k = s.a; k <= s.z; k++) {
				const x = spot(k).left
				ts.push((starts[k]! + s.from + ((x - s.left) / (s.right - s.left)) * (s.to - s.from)) / 2)
				xs.push(x)
			}
			ts.push(s.to)
			xs.push(s.right)
			path = monotone(ts, xs)
			paths.set(s.a, path)
		}
		return path(t)
	}
	/** Where the reader is at time `t`, in words: the word's index plus how far through it. */
	const place = (t: number) => {
		if (t <= starts[first]!) return first
		let k = Math.max(first, Math.min(i, all.length - 1))
		while (k > first && starts[k]! > t) k--
		while (all[k + 1] && starts[k + 1]! <= t) k++
		return k + clamp01((t - starts[k]!) / lengths[k]!)
	}

	// How strongly each word near the place is lit, from 0 (the floor) to 1 (full ink).
	const shades = new Map<number, number>()
	const levels = lamp
		? Array.from({ length: 11 }, (_, k) => {
				const h = new Highlight()
				h.priority = k ? 1 : 0
				CSS.highlights.set(`pacer-${k}`, h)
				return h
			})
		: []
	if (lamp) {
		const all = new Range()
		all.selectNodeContents(el)
		levels[0]!.add(all)
	}
	const lit = (o: number) => (o - LAMP_FLOOR) / (1 - LAMP_FLOOR)
	const shade = (t: number, dt: number, cur: Span) => {
		const target = new Map<number, number>()
		if (style === 'Lamp') {
			// The next 2 to 3 words stay dark so the eye can see ahead; words just read stay dark a moment for a look back.
			const [c, back] = [place(t), place(t - 1500)]
			for (let j = Math.max(0, Math.floor(back) - 8); j <= Math.min(all.length - 1, Math.ceil(c) + 7); j++)
				target.set(j, j >= c ? 1 - smooth((j - c - 2.5) / 3.5) : 1 - smooth((back - j - 1) / 6))
		} else {
			const fill = (l: { a: number; z: number }, o: (k: number) => number) => {
				for (let k = l.a; k <= l.z; k++) target.set(k, o(k))
			}
			if (cur.a > first) fill(lineOf(cur.a - 1), () => lit(0.75))
			fill(cur, (k) => (k < i ? lit(0.88) : 1))
			if (all[cur.z + 1]) fill(lineOf(cur.z + 1), () => lit(0.85))
		}
		// Changes ease in, so a new line brightens over 0.4 s rather than switching.
		const step = shades.size ? dt / (style === 'Lamp' ? 150 : 400) : 1
		for (const j of new Set([...shades.keys(), ...target.keys()])) {
			const s = shades.get(j) ?? 0
			const next = s + Math.max(-step, Math.min(step, (target.get(j) ?? 0) - s))
			if (next <= 0) shades.delete(j)
			else shades.set(j, next)
		}
		for (let k = 1; k <= 10; k++) levels[k]!.clear()
		for (const [j, s] of shades) if (Math.round(s * 10) > 0) levels[Math.round(s * 10)]!.add(wordRange(all[j]!))
	}

	let shown = -1
	let last = performance.now()
	// Time the page was too busy to draw, left out of the Pacer's clock: after a stall the guide goes
	// on from where it was, rather than leaping ahead to catch up.
	let lost = 0
	// The page's move up to the next line, while one is under way.
	let glide: { from: number; by: number; at: number } | null = null
	let frame = 0
	const tick = () => {
		const real = performance.now()
		const gap = real - last
		last = real
		// Only a real stall counts: a device that draws fewer frames, such as one saving power, keeps full speed.
		if (gap > 200) lost += gap - 1000 / 60
		const t = real - lost
		const dt = Math.min(gap, 50)
		const now = words()
		if (now !== all) {
			// The text changed under the Pacer, such as words worth knowing marked. With the same words
			// the plan still holds; otherwise the rest is planned again from the word it is on, at the same time.
			const same = now.length === all.length
			all = now
			forget()
			shades.clear()
			if (!same) {
				plan = timing(all)
				i = Math.min(i, all.length - 1)
				first = Math.min(first, i)
				if (i >= 0) schedule(i, starts[i] ?? t, 0, 1)
			}
		}
		while (all[i + 1] && starts[i + 1]! <= t) i++
		if (!all[i] || t >= end) return onEnd()
		const cur = span(i)
		// The page moves only as the reader goes to a new line, while the eyes sweep back anyway: once
		// the line is below a calm height, the page eases up by about a line, and the text stays still
		// while it is read. A line far out of view, such as after a tap low on the screen, is brought
		// back in one smooth move.
		if (shown < 0 || lineOf(shown) !== lineOf(i)) {
			const y = el.getBoundingClientRect().top + cur.bottom
			const calm = TOP + (window.innerHeight - TOP) * 0.35
			if (y < TOP || y > window.innerHeight - 24) keepInView(wordRange(all[i]!).getBoundingClientRect())
			else if (y > calm) glide = { from: window.scrollY, by: y - calm, at: real }
		}
		if (glide) {
			const p = clamp01((real - glide.at) / 350)
			window.scrollTo(0, glide.from + glide.by * (p < 0.5 ? 2 * p * p : 1 - (2 - 2 * p) ** 2 / 2))
			if (p === 1) glide = null
		}
		if (i !== shown) {
			shown = i
			onWord(i)
		}
		if (lined) {
			// The line's front is where the reading will be LEAD_MS from now. The next line's line comes in
			// already moving as the old one slides off, so there is never a gap or a still mark appearing.
			const g = t + LEAD_MS
			const near = [cur]
			if (cur.a > first) near.unshift(span(cur.a - 1))
			if (all[cur.z + 1]) near.push(span(cur.z + 1))
			const used = new Set<HTMLElement>()
			for (const s of near) {
				const o = Math.min(clamp01((g - s.from + 150) / 150), clamp01(1 - (g - s.to) / 150))
				if (o <= 0) continue
				const long = s.to - s.from
				const at = s.from + long * settle((g - s.from) / long, Math.min(0.3, SETTLE_MS / long))
				const x = style === 'Fingertip' ? finger(s, at) : steady(s, at)
				let b = slots.get(s.a)
				if (!b) slots.set(s.a, (b = bars[turn++ % bars.length]!))
				b.style.transform = `translate(${x - width}px, ${s.bottom + 2}px)`
				b.style.opacity = String(o)
				used.add(b)
			}
			for (const b of bars) if (!used.has(b)) b.style.opacity = '0'
		}
		if (lamp) shade(t, dt, cur)
		frame = requestAnimationFrame(tick)
	}
	const resized = new ResizeObserver(forget)
	resized.observe(el)
	tick()
	return () => {
		cancelAnimationFrame(frame)
		resized.disconnect()
		for (let k = 0; k < levels.length; k++) CSS.highlights.delete(`pacer-${k}`)
	}
}

function caretAt(x: number, y: number) {
	const pos = document.caretPositionFromPoint?.(x, y)
	if (pos) return { node: pos.offsetNode, offset: pos.offset }
	const range = document.caretRangeFromPoint?.(x, y)
	return range && { node: range.startContainer, offset: range.startOffset }
}

/**
 * The Pacer and Read aloud: a mark that moves word by word through the text in `root`, at `pace`
 * words a minute or with the device's voice at `rate`, and the bar at the bottom that starts and
 * stops it. It starts at the first word on screen, or at a word the member taps. Without a voice,
 * or with one that does not report its words, the mark follows the voice's usual pace.
 */
export function FocusPlayer({
	root,
	aid,
	style,
	pace,
	setPace,
	rate,
	setRate,
}: {
	root: RefObject<HTMLElement | null>
	aid: 'Pacer' | 'Read aloud'
	style: PacerStyle
	pace: Pace
	setPace: (p: Pace) => void
	rate: Rate
	setRate: (r: Rate) => void
}) {
	const voice = useVoice(aid === 'Read aloud')
	const [playing, setPlaying] = useState(false)
	// Bumped to start again from a word the member tapped.
	const [from, setFrom] = useState(0)
	const at = useRef<number | null>(null)
	const words = useRef<Word[]>([])
	// When the Pacer last stopped, to pick up gently after a short stop; null for a fresh start.
	const left = useRef<number | null>(null)
	// Set by a tap on a word, which always starts afresh there.
	const tapped = useRef(false)
	const bars = useRef<HTMLElement[]>([])

	useEffect(() => () => markWord(null), [])

	// The Pacer's lines live in the text, so they scroll with it and no frame has to chase the page.
	// Two, so one can slide off the end of a line while the next comes in; clipped to the text's edges.
	useEffect(() => {
		const el = root.current
		if (aid !== 'Pacer' || !el) return
		const clip = document.createElement('div')
		clip.setAttribute('aria-hidden', 'true')
		clip.className = 'pointer-events-none absolute inset-x-0 top-0 -bottom-3 z-10 overflow-hidden'
		bars.current = [0, 1].map(() => {
			const b = document.createElement('div')
			b.className = 'absolute top-0 left-0 h-[3px] w-[12ch] rounded-full opacity-0 will-change-transform'
			b.style.background = 'linear-gradient(to right, transparent, color-mix(in srgb, var(--world-accent) 60%, transparent) 45%)'
			clip.append(b)
			return b
		})
		el.append(clip)
		return () => {
			clip.remove()
			bars.current = []
			delete el.dataset.pacer
		}
	}, [aid, root])

	useEffect(() => {
		const el = root.current
		if (!playing || !el) return
		let stopped = false
		let timer = 0
		const list = () => {
			if (!words.current[0]?.node.isConnected) words.current = textWords(el)
			return words.current
		}
		const done = () => {
			at.current = null
			left.current = null
			markWord(null)
			for (const b of bars.current) b.style.opacity = '0'
			delete el.dataset.pacer
			setPlaying(false)
		}
		if (at.current === null || tapped.current) left.current = null
		tapped.current = false
		if (at.current === null) {
			const i = list().findIndex((w) => wordRange(w).getBoundingClientRect().bottom > TOP)
			at.current = Math.max(0, i)
		}

		if (aid === 'Pacer') {
			// After a long stop the reader has lost the thread, so the Pacer goes back to the start of the sentence.
			const away = left.current === null ? null : performance.now() - left.current
			if (away !== null && away > 15_000) at.current = sentenceStart(list(), at.current ?? 0)
			const stopPacer = runPacer({
				el,
				words: list,
				from: at.current ?? 0,
				style,
				pace: Number(pace),
				resumed: away !== null && away <= 15_000,
				bars: bars.current,
				onWord: (i) => {
					at.current = i
					el.dataset.pacer = wordText(list()[i]!)
				},
				onEnd: done,
			})
			// Scrolling by hand or leaving the page means the member has stopped following the guide.
			const stop = () => setPlaying(false)
			const hidden = () => document.hidden && stop()
			window.addEventListener('wheel', stop, { passive: true })
			window.addEventListener('touchmove', stop, { passive: true })
			document.addEventListener('visibilitychange', hidden)
			return () => {
				stopPacer()
				window.removeEventListener('wheel', stop)
				window.removeEventListener('touchmove', stop)
				document.removeEventListener('visibilitychange', hidden)
				if (at.current !== null) left.current = performance.now()
			}
		} else {
			// The mark at a steady pace through `part`, for a voice that doesn't say which word it is on.
			const steady = (part: number[], then?: () => void) => {
				const all = list()
				const plan = timeline(all)
				let k = 0
				const step = () => {
					if (stopped) return
					const i = part[k]
					if (i === undefined) return then?.()
					at.current = i
					markWord(all[i]!)
					k++
					timer = window.setTimeout(step, (60_000 / (VOICE_WPM * Number(rate))) * (plan.word[i]! + plan.rest[i]!))
				}
				step()
			}
			// One block at a time, so the mark and the voice meet again at every paragraph.
			const speak = () => {
				if (stopped) return
				const all = list()
				const start = at.current ?? 0
				const first = all[start]
				if (!first) return done()
				const part: number[] = []
				for (let i = start; all[i]?.block === first.block; i++) part.push(i)
				const next = () => {
					window.clearTimeout(timer)
					at.current = part.at(-1)! + 1
					speak()
				}
				markWord(first)
				if (!voice) return steady(part, next)
				const offsets: number[] = []
				let text = ''
				for (const i of part) {
					offsets.push(text.length)
					text += `${wordText(all[i]!)} `
				}
				const said = new SpeechSynthesisUtterance(text)
				said.voice = voice
				said.lang = voice.lang
				said.rate = Number(rate)
				let started = false
				let heard = false
				let gaveUp = false
				said.onstart = () => {
					started = true
					timer = window.setTimeout(() => !heard && !stopped && steady(part), 900)
				}
				said.onboundary = (e) => {
					if (stopped || (e.name && e.name !== 'word')) return
					if (!heard) window.clearTimeout(timer)
					heard = true
					let k = 0
					while (k + 1 < offsets.length && offsets[k + 1]! <= e.charIndex) k++
					at.current = part[k]!
					markWord(all[part[k]!]!)
				}
				said.onend = () => !stopped && !gaveUp && next()
				said.onerror = (e) => {
					if (stopped || gaveUp || e.error === 'interrupted' || e.error === 'canceled') return
					gaveUp = true
					steady(part, next)
				}
				// A voice that never starts, such as one the browser blocks, still lets the mark go on.
				window.setTimeout(() => {
					if (stopped || started) return
					gaveUp = true
					speechSynthesis.cancel()
					steady(part, next)
				}, 2000)
				speechSynthesis.speak(said)
			}
			// Cancelling and speaking at once can drop the new speech in some browsers.
			timer = window.setTimeout(speak, 60)
		}
		return () => {
			stopped = true
			window.clearTimeout(timer)
			if ('speechSynthesis' in window) speechSynthesis.cancel()
		}
	}, [playing, from, aid, style, pace, rate, voice, root])

	useEffect(() => {
		const el = root.current
		if (!el) return
		const onClick = (e: MouseEvent) => {
			if (e.defaultPrevented || (e.target as HTMLElement).closest('a, button, input, textarea, dialog')) return
			if (!document.getSelection()?.isCollapsed) return
			const caret = caretAt(e.clientX, e.clientY)
			if (!caret) return
			words.current = textWords(el)
			const i = words.current.findIndex((w) => w.node === caret.node && w.start <= caret.offset && caret.offset <= w.end)
			if (i < 0) return
			at.current = i
			tapped.current = true
			setFrom((n) => n + 1)
			setPlaying(true)
		}
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== ' ' || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return
			// A focused button takes Space itself.
			if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"], dialog, button, a')) return
			e.preventDefault()
			setPlaying((p) => !p)
		}
		el.addEventListener('click', onClick)
		window.addEventListener('keydown', onKey)
		return () => {
			el.removeEventListener('click', onClick)
			window.removeEventListener('keydown', onKey)
		}
	}, [root])

	// Listed in order: Object.keys would put a key like '1' before '0.75'.
	const steps: string[] = aid === 'Pacer' ? PACE_ORDER : RATE_ORDER
	const k = steps.indexOf(aid === 'Pacer' ? pace : rate)
	const setSpeed = (s: string) => (aid === 'Pacer' ? setPace(s as Pace) : setRate(s as Rate))
	const small = 'grid size-8 place-items-center rounded-full text-world-muted transition hover:bg-world hover:text-world-ink disabled:opacity-40'
	return (
		<div className="pointer-events-none fixed inset-x-0 bottom-24 z-30 flex justify-center px-4 leading-normal md:bottom-6">
			<div role="group" aria-label={aid} className="pointer-events-auto flex items-center gap-1 rounded-full bg-world-card p-1.5 font-sans text-sm shadow-lg ring-1 ring-world-line">
				<button
					type="button"
					onClick={() => setPlaying((p) => !p)}
					className="min-w-20 rounded-full bg-world-accent px-4 py-1.5 font-semibold text-world-on-accent transition hover:opacity-90 active:scale-[0.97]"
				>
					{playing ? 'Pause' : at.current !== null ? 'Go on' : aid === 'Pacer' ? 'Start' : 'Listen'}
				</button>
				<button type="button" aria-label="Slower" disabled={k <= 0} onClick={() => setSpeed(steps[k - 1]!)} className={small}>
					−
				</button>
				{aid === 'Pacer' ? (
					<span className="min-w-24 text-center text-world-ink tabular-nums">{pace} words a minute</span>
				) : (
					<span className="flex min-w-24 flex-col text-center leading-tight tabular-nums">
						<span className="text-world-ink">{rate}× speed</span>
						<span className="text-xs text-world-muted">about {Math.round((VOICE_WPM * Number(rate)) / 5) * 5} words a minute</span>
					</span>
				)}
				<button type="button" aria-label="Faster" disabled={k >= steps.length - 1} onClick={() => setSpeed(steps[k + 1]!)} className={small}>
					+
				</button>
				{aid === 'Read aloud' && !voice && <span className="hidden pr-2 text-xs text-world-muted sm:inline">No voice on this device; the mark keeps a steady pace.</span>}
				<span className="hidden pr-3 pl-1 text-xs text-world-muted md:inline">
					<kbd className="rounded border border-world-line px-1">Space</kbd>
				</span>
			</div>
		</div>
	)
}

const TEXT_BLOCKS = new Set<Block['type']>(['paragraph', 'quote', 'list'])
/** About a minute of reading between checks. */
const CHECK_WORDS = 200

/**
 * Where Drift check asks: at the end of the paragraph where about CHECK_WORDS words have passed
 * since the last check, never after the last text. `from` is the first block of that part.
 */
function checkPoints(blocks: Block[]) {
	const counts = blocks.map((b) => (TEXT_BLOCKS.has(b.type) ? countWords(blockText(b)) : 0))
	const points: { after: number; from: number; words: number }[] = []
	let words = 0
	let from = 0
	blocks.forEach((b, i) => {
		words += counts[i]!
		if (words < CHECK_WORDS || !TEXT_BLOCKS.has(b.type) || !counts.slice(i + 1).some((n) => n > 0)) return
		points.push({ after: i, from, words })
		words = 0
		from = i + 1
	})
	return points
}

/**
 * Drift check for a section's `blocks` in `root`: returns what to show after block `i`. The next
 * check asks once its place is on screen and there was time to read the part before it, at a brisk
 * 300 words a minute. I drifted goes back to the start of that part and asks again at its end.
 * A check the member scrolls well past unanswered is let go.
 */
export function useDriftCheck(blocks: Block[], on: boolean, root: RefObject<HTMLElement | null>) {
	const toast = useToast()
	const points = useMemo(() => checkPoints(blocks), [blocks])
	const [next, setNext] = useState(0)
	const [withIt, setWithIt] = useState<number[]>([])
	const [asking, setAsking] = useState(false)
	const since = useRef(0)
	const spot = useRef<HTMLDivElement>(null)
	useEffect(() => {
		since.current = Date.now()
		setNext(0)
		setWithIt([])
		setAsking(false)
	}, [on, points])
	const point = points[next]
	useEffect(() => {
		if (!on || !point) return
		const tick = window.setInterval(() => {
			const el = spot.current
			if (!el || document.hidden) return
			const { top } = el.getBoundingClientRect()
			if (top < TOP - 200) {
				since.current = Date.now()
				setAsking(false)
				setNext((n) => n + 1)
			} else if (top < window.innerHeight * 0.8 && Date.now() - since.current >= (point.words / 300) * 60_000) setAsking(true)
		}, 1000)
		return () => window.clearInterval(tick)
	}, [on, point])

	const answer = (yes: boolean) => {
		since.current = Date.now()
		setAsking(false)
		if (yes) {
			setWithIt((w) => [...w, next])
			setNext(next + 1)
			return
		}
		const start = root.current?.querySelector<HTMLElement>(`[data-block="${point?.from ?? 0}"]`)
		if (start) {
			start.scrollIntoView({ block: 'start', behavior: 'smooth' })
			const accent = getComputedStyle(start).getPropertyValue('--world-accent').trim()
			start.animate([{ backgroundColor: `color-mix(in srgb, ${accent} 16%, transparent)` }, { backgroundColor: 'transparent' }], { duration: 1600 })
		}
		toast({ text: 'Back to where this part starts. Take it slowly.' })
	}

	return (i: number) => {
		const k = points.findIndex((p) => p.after === i)
		if (!on || k < 0 || k > next) return null
		if (k < next) return withIt.includes(k) ? <p className="font-sans text-sm text-path">✓ With it</p> : null
		return (
			<div ref={spot} className="min-h-px">
				{asking && (
					<div role="group" aria-label="Drift check" className="flex animate-[toast-in_.2s_ease-out] flex-wrap items-center gap-2 font-sans text-sm leading-normal">
						<span className="mr-1">Still with it?</span>
						<button type="button" onClick={() => answer(true)} className="rounded-lg border border-world-line px-3 py-1 transition hover:bg-world-card active:scale-[0.97]">
							Yes
						</button>
						<button type="button" onClick={() => answer(false)} className="rounded-lg border border-world-line px-3 py-1 transition hover:bg-world-card active:scale-[0.97]">
							I drifted
						</button>
					</div>
				)}
			</div>
		)
	}
}
