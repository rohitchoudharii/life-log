import { strToU8, zipSync } from 'fflate'

const para = (n: number, word = 'word') => Array.from({ length: n }, (_, i) => `${word}${i}`).join(' ')

/**
 * A small EPUB 3 for tests: a cover, then three chapters in two files listed in its navigation,
 * and an image. `files` adds or replaces files, as text or bytes.
 */
export function testEpub(files: Record<string, string | Uint8Array> = {}) {
	return zipSync({
		mimetype: strToU8('application/epub+zip'),
		'META-INF/container.xml': strToU8('<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/book.opf"/></rootfiles></container>'),
		'OEBPS/book.opf': strToU8(`<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>Test Book</dc:title></metadata>
			<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/><item id="a" href="text/a.xhtml" media-type="application/xhtml+xml"/><item id="b" href="text/b.xhtml" media-type="application/xhtml+xml"/><item id="img" href="images/fig.png" media-type="image/png"/></manifest>
			<spine><itemref idref="cover"/><itemref idref="a"/><itemref idref="b"/></spine></package>`),
		'OEBPS/nav.xhtml': strToU8(`<html xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol>
			<li><a href="text/a.xhtml#c1">Chapter One</a></li><li><a href="text/a.xhtml#c2">Chapter Two</a></li><li><a href="text/b.xhtml">Chapter Three</a></li></ol></nav></body></html>`),
		'OEBPS/cover.xhtml': strToU8('<html><body><p>Cover</p></body></html>'),
		'OEBPS/text/a.xhtml': strToU8(`<html><body><h2 id="c1">Chapter One</h2><p>${para(80, 'one')}</p><h3>A part</h3><p>${para(70, 'part')}</p>
			<h2 id="c2">Chapter Two</h2><p>${para(80, 'two')}</p><img src="../images/fig.png" alt="Figure"/></body></html>`),
		'OEBPS/text/b.xhtml': strToU8(`<html><body><h1>Chapter Three</h1><p>${para(90, 'three')}</p><script>alert(1)</script></body></html>`),
		'OEBPS/images/fig.png': strToU8('png bytes'),
		...Object.fromEntries(Object.entries(files).map(([k, v]) => [k, typeof v === 'string' ? strToU8(v) : v])),
	})
}

/** A one-page PDF with nothing on its page, as a scan without a text layer reads to pdf.js. */
export const blankPdf = () =>
	pdfOf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>'])

export type TestBookmark = { title: string; page: number; top?: number; items?: TestBookmark[] }

/**
 * A PDF with a text layer for tests. Each page is a list of lines, `[text, size]` (10 when no
 * size), set top down in Helvetica from the top margin. `outline` becomes its bookmarks, each
 * pointing at a page (from 1) and, when `top` is set, at that height on it.
 */
export function testPdf(pages: (string | [string, number])[][], outline: TestBookmark[] = []) {
	const escape = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`)
	const objects: string[] = []
	const add = (o: string) => objects.push(o)
	add('') // 1: catalog, written last
	add(`<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`)
	add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
	for (const lines of pages) {
		let y = 740
		const stream = lines
			.map((line) => {
				const [text, size] = typeof line === 'string' ? [line, 10] : line
				y -= size * 1.5
				return `BT /F1 ${size} Tf 72 ${y} Td (${escape(text)}) Tj ET`
			})
			.join('\n')
		add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${objects.length + 2} 0 R >>`)
		add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
	}
	// Bookmarks are a linked tree: each item knows its parent, siblings and children.
	const root = objects.length + 1
	add('')
	const place = (items: TestBookmark[], parent: number): number[] => {
		const ids = items.map(() => {
			add('')
			return objects.length
		})
		items.forEach((item, i) => {
			const kids = item.items?.length ? place(item.items, ids[i]!) : []
			const dest = `[${4 + (item.page - 1) * 2} 0 R ${item.top === undefined ? '/Fit' : `/XYZ 0 ${item.top} null`}]`
			objects[ids[i]! - 1] =
				`<< /Title (${escape(item.title)}) /Parent ${parent} 0 R /Dest ${dest}` +
				(i > 0 ? ` /Prev ${ids[i - 1]} 0 R` : '') +
				(i < ids.length - 1 ? ` /Next ${ids[i + 1]} 0 R` : '') +
				(kids.length ? ` /First ${kids[0]} 0 R /Last ${kids.at(-1)} 0 R /Count ${kids.length}` : '') +
				' >>'
		})
		return ids
	}
	const top = place(outline, root)
	objects[root - 1] = top.length ? `<< /Type /Outlines /First ${top[0]} 0 R /Last ${top.at(-1)} 0 R /Count ${top.length} >>` : '<< /Type /Outlines /Count 0 >>'
	objects[0] = `<< /Type /Catalog /Pages 2 0 R /Outlines ${root} 0 R >>`
	return pdfOf(objects)
}

/**
 * A scan of `testPdf(pages)`: each page drawn at 150 dots per inch and stored as a JPEG image,
 * with no text layer, as a scanner makes it.
 */
export async function scannedPdf(pages: (string | [string, number])[][]) {
	const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
	const { createCanvas } = await import('@napi-rs/canvas')
	const doc = await getDocument({ data: testPdf(pages), isEvalSupported: false, verbosity: 0 }).promise
	const images: { jpeg: Uint8Array; width: number; height: number }[] = []
	for (let n = 1; n <= doc.numPages; n++) {
		const page = await doc.getPage(n)
		const viewport = page.getViewport({ scale: 150 / 72 })
		const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
		const context = canvas.getContext('2d')
		context.fillStyle = 'white'
		context.fillRect(0, 0, canvas.width, canvas.height)
		await page.render({ canvas: canvas as never, canvasContext: context as never, viewport }).promise
		images.push({ jpeg: new Uint8Array(canvas.toBuffer('image/jpeg', 85)), width: canvas.width, height: canvas.height })
	}
	await doc.destroy()
	// Objects as bytes: the images are binary, so they can't go through pdfOf's strings.
	const parts: Uint8Array[] = []
	const offsets: number[] = []
	let length = 0
	const push = (bytes: Uint8Array) => {
		parts.push(bytes)
		length += bytes.length
	}
	const text = (t: string) => push(strToU8(t, true))
	text('%PDF-1.4\n')
	const object = (body: () => void) => {
		offsets.push(length)
		text(`${offsets.length} 0 obj\n`)
		body()
		text('\nendobj\n')
	}
	object(() => text('<< /Type /Catalog /Pages 2 0 R >>'))
	object(() => text(`<< /Type /Pages /Kids [${images.map((_, i) => `${3 + i * 3} 0 R`).join(' ')}] /Count ${images.length} >>`))
	images.forEach((image, i) => {
		const draw = '612 0 0 792 0 0 cm /Im0 Do'
		object(() => text(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 ${5 + i * 3} 0 R >> >> /Contents ${4 + i * 3} 0 R >>`))
		object(() => text(`<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`))
		object(() => {
			text(`<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.jpeg.length} >>\nstream\n`)
			push(image.jpeg)
			text('\nendstream')
		})
	})
	const xref = length
	text(`xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`)
	text(`trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
	const out = new Uint8Array(length)
	let at = 0
	for (const part of parts) {
		out.set(part, at)
		at += part.length
	}
	return out
}

/** Writes numbered objects as a PDF file, with its cross-reference table. */
function pdfOf(objects: string[]) {
	let body = '%PDF-1.4\n'
	const offsets: number[] = []
	objects.forEach((o, i) => {
		offsets.push(body.length)
		body += `${i + 1} 0 obj\n${o}\nendobj\n`
	})
	const xref = body.length
	body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
	body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
	return strToU8(body)
}
