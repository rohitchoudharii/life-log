import { Worker } from 'node:worker_threads'
import type { Chapter, Note } from '@life-log-club/domain'
import { BOOK_TOO_LARGE } from './epub'
import { ExtractError } from './extract'

export type BookKind = 'epub' | 'pdf'
/** `article` is true for a PDF with no outline and no headings, which is split like an article. */
export type Book = { title: string; author: string | null; chapters: Chapter[]; notes: Note[]; article: boolean; images: [src: string, bytes: Uint8Array][] }

const TIME_LIMIT = 2 * 60 * 1000

/** What kind of book the bytes are, from their first bytes rather than the file's name. */
export function bookKind(bytes: Uint8Array): BookKind | null {
	if (bytes.length > 4 && Buffer.from(bytes.subarray(0, 5)).toString('latin1') === '%PDF-') return 'pdf'
	if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return 'epub'
	return null
}

/**
 * Reads an EPUB or PDF in a worker thread, with a memory cap and a time limit, so one large or
 * hostile file can't stall or crash the server. Throws ExtractError with a message for the member.
 */
export function parseBook(kind: BookKind, bytes: Uint8Array, name: string): Promise<Book> {
	return new Promise((resolve, reject) => {
		// The worker runs TypeScript through tsx, as the server does; tests run without it, so it is asked for here.
		const worker = new Worker(new URL('./book-worker.ts', import.meta.url), {
			workerData: { kind, bytes, name },
			execArgv: ['--import', 'tsx'],
			resourceLimits: { maxOldGenerationSizeMb: 1024 },
		})
		const timer = setTimeout(() => {
			void worker.terminate()
			reject(new ExtractError('This file took too long to read. Try again, or try another copy.'))
		}, TIME_LIMIT)
		worker.once('message', (message: { book?: Book; refused?: string }) => {
			clearTimeout(timer)
			void worker.terminate()
			if (message.book) resolve(message.book)
			else reject(new ExtractError(message.refused))
		})
		worker.once('error', (error: Error & { code?: string }) => {
			clearTimeout(timer)
			reject(error.code === 'ERR_WORKER_OUT_OF_MEMORY' ? new ExtractError(BOOK_TOO_LARGE) : error)
		})
		worker.once('exit', () => {
			clearTimeout(timer)
			reject(new Error('The book worker stopped without an answer'))
		})
	})
}
