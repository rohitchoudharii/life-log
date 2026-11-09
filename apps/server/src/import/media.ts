import { randomUUID } from 'node:crypto'
import type { Block } from '@life-log-club/domain'
import sharp from 'sharp'

const ACCEPTED = new Set(['jpeg', 'png', 'webp', 'gif', 'avif', 'heif', 'tiff'])
/** Smaller than this is an icon, a spacer or a tracking pixel, not part of the reading. */
const MIN_SIDE = 48
const MAX_WIDTH = 1600
const MAX_PIXELS = 50_000_000

export type PreparedImage = { data: Buffer; width: number; height: number }

/**
 * Checks that the bytes really are a raster image and re-encodes them as WebP, which drops
 * metadata and anything hidden in the file. SVG is refused, since it can carry scripts. Returns
 * null for anything that is not a usable image.
 */
export async function prepareImage(input: Uint8Array): Promise<PreparedImage | null> {
	try {
		const meta = await sharp(input, { limitInputPixels: MAX_PIXELS }).metadata()
		if (!meta.format || !ACCEPTED.has(meta.format)) return null
		if ((meta.width ?? 0) < MIN_SIDE || (meta.height ?? 0) < MIN_SIDE) return null
		const { data, info } = await sharp(input, { limitInputPixels: MAX_PIXELS, animated: false })
			.rotate()
			.resize({ width: MAX_WIDTH, withoutEnlargement: true })
			.webp({ quality: 80 })
			.toBuffer({ resolveWithObject: true })
		return { data, width: info.width, height: info.height }
	} catch {
		return null
	}
}

const BATCH = 4

/**
 * Gets each image's bytes with `bytesOf`, four at a time, and re-encodes them with prepareImage.
 * `withImages` then points an image block at its stored image by id, the same id for every block
 * with the same source; an image that can't be used keeps its description, if it has one.
 * `images` holds the re-encoded images to store, by id.
 */
export async function prepareImages(srcs: Iterable<string>, bytesOf: (src: string) => Uint8Array | null | Promise<Uint8Array | null>) {
	const unique = [...new Set(srcs)]
	const prepared = new Map<string, PreparedImage | null>()
	for (let k = 0; k < unique.length; k += BATCH)
		await Promise.all(
			unique.slice(k, k + BATCH).map(async (src) => {
				const bytes = await bytesOf(src)
				prepared.set(src, bytes ? await prepareImage(bytes) : null)
			}),
		)
	const images = new Map<string, PreparedImage>()
	const ids = new Map<string, string>()
	const withImages = (b: Block): Block[] => {
		if (b.type !== 'image') return [b]
		const image = b.src ? prepared.get(b.src) : null
		// An image that can't be shown (an icon, an SVG) keeps its description, if it has one.
		if (!image) return b.alt ? [{ type: 'image', mediaId: null, alt: b.alt }] : []
		let id = ids.get(b.src!)
		if (!id) {
			id = randomUUID()
			ids.set(b.src!, id)
			images.set(id, image)
		}
		return [{ type: 'image', mediaId: id, alt: b.alt, width: image.width, height: image.height }]
	}
	return { images, withImages }
}
