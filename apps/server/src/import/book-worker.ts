// Parses one book off the main thread: pdf.js and unzipping hold the CPU without yielding, which
// would stall every member's requests and the job's heartbeat. See parseBook in book.ts.
import { parentPort, workerData } from 'node:worker_threads'
import type { Book } from './book'
import { readEpub } from './epub'
import { ExtractError } from './extract'
import { readPdf } from './pdf'

const { kind, bytes, name } = workerData as { kind: 'epub' | 'pdf'; bytes: Uint8Array; name: string }
try {
	let book: Book
	if (kind === 'epub') {
		const epub = readEpub(bytes)
		book = { ...epub, article: false, images: [...epub.images] }
	} else book = { ...(await readPdf(bytes, name, (done, total) => parentPort!.postMessage({ scan: { done, total } }))), images: [] }
	parentPort!.postMessage({ book })
} catch (error) {
	if (error instanceof ExtractError) parentPort!.postMessage({ refused: error.message })
	else throw error
}
