// Parses one book off the main thread: pdf.js and unzipping hold the CPU without yielding, which
// would stall every member's requests and the job's heartbeat. See parseBook in book.ts.
import { parentPort, workerData } from 'node:worker_threads'
import { readEpub } from './epub'
import { ExtractError } from './extract'
import { readPdf } from './pdf'

const { kind, bytes, name } = workerData as { kind: 'epub' | 'pdf'; bytes: Uint8Array; name: string }
try {
	if (kind === 'epub') {
		const book = readEpub(bytes)
		parentPort!.postMessage({ book: { ...book, images: [...book.images] } })
	} else parentPort!.postMessage({ book: { ...(await readPdf(bytes, name)), images: [] } })
} catch (error) {
	if (error instanceof ExtractError) parentPort!.postMessage({ refused: error.message })
	else throw error
}
