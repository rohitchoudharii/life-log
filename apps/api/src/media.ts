import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import sharp from 'sharp'
import { db, t } from './db'
import { env } from './env'

/** Where image bytes live. Local disk now; an S3-compatible store can implement the same two calls. */
export interface MediaStore {
	put(id: string, bytes: Buffer): Promise<void>
	get(id: string): Promise<Buffer | null>
}

class DiskStore implements MediaStore {
	constructor(private readonly root: string) {}
	// Ids are UUIDs we generate, so the path cannot escape the root.
	private path = (id: string) => join(this.root, id.slice(0, 2), `${id}.webp`)
	async put(id: string, bytes: Buffer) {
		await mkdir(dirname(this.path(id)), { recursive: true })
		await writeFile(this.path(id), bytes)
	}
	async get(id: string) {
		return readFile(this.path(id)).catch(() => null)
	}
}

export const mediaStore: MediaStore = new DiskStore(resolve(env.MEDIA_DIR))

const ACCEPTED = new Set(['jpeg', 'png', 'webp', 'gif', 'avif', 'heif', 'tiff'])
/** Smaller than this is an icon, spacer, or tracking pixel, not part of the article. */
const MIN_SIDE = 48
const MAX_WIDTH = 1600

export type SavedImage = { id: string; width: number; height: number }

/**
 * Checks that the bytes really are a raster image, re-encodes them as WebP (which drops metadata
 * and anything hidden in the file), and stores the result. SVG is refused, since it can carry
 * scripts. Returns null for anything that is not a usable image.
 */
export async function saveImage(userId: string, input: Buffer): Promise<SavedImage | null> {
	try {
		const meta = await sharp(input, { limitInputPixels: 50_000_000 }).metadata()
		if (!meta.format || !ACCEPTED.has(meta.format)) return null
		if ((meta.width ?? 0) < MIN_SIDE || (meta.height ?? 0) < MIN_SIDE) return null
		const { data, info } = await sharp(input, { limitInputPixels: 50_000_000, animated: false })
			.rotate()
			.resize({ width: MAX_WIDTH, withoutEnlargement: true })
			.webp({ quality: 80 })
			.toBuffer({ resolveWithObject: true })
		const id = randomUUID()
		await mediaStore.put(id, data)
		await db.insert(t.media).values({ id, userId, contentType: 'image/webp', bytes: data.length, width: info.width, height: info.height })
		return { id, width: info.width, height: info.height }
	} catch {
		return null
	}
}
