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
