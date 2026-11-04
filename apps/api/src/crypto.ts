import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { env } from './env'

const kek = Buffer.from(env.ENCRYPTION_KEY, 'base64')

function seal(key: Buffer, plain: Buffer) {
	const iv = randomBytes(12)
	const cipher = createCipheriv('aes-256-gcm', key, iv)
	const ct = Buffer.concat([cipher.update(plain), cipher.final()])
	return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ct: ct.toString('base64') }
}

function open(key: Buffer, box: { iv: string; tag: string; ct: string }) {
	const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'))
	decipher.setAuthTag(Buffer.from(box.tag, 'base64'))
	return Buffer.concat([decipher.update(Buffer.from(box.ct, 'base64')), decipher.final()])
}

/**
 * Envelope encryption: each secret gets its own data key, and only the data key is
 * encrypted with the master key. Rotating the master key means rewrapping data keys only.
 */
export function encryptSecret(plain: string): string {
	const dek = randomBytes(32)
	return JSON.stringify({ v: 1, key: seal(kek, dek), data: seal(dek, Buffer.from(plain, 'utf8')) })
}

export function decryptSecret(stored: string): string {
	const { key, data } = JSON.parse(stored)
	return open(open(kek, key), data).toString('utf8')
}

export const newOtpCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0')

export const hashOtp = (email: string, code: string) =>
	createHmac('sha256', env.OTP_SECRET).update(`${email}:${code}`).digest('hex')

export function safeEqualHex(a: string, b: string) {
	const ab = Buffer.from(a, 'hex')
	const bb = Buffer.from(b, 'hex')
	return ab.length === bb.length && timingSafeEqual(ab, bb)
}

export const newSessionToken = () => randomBytes(32).toString('base64url')

// Session tokens are 256 random bits, so a plain hash is enough to keep stolen DB rows useless.
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')
