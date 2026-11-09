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
export function blankPdf() {
	const objects = [
		'<< /Type /Catalog /Pages 2 0 R >>',
		'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
		'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>',
	]
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
