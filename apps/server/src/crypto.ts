import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { env } from './env'

// Values are stored as `<key id>.<iv>.<tag>.<ciphertext>`. The key id lets a new key be added
// later while old values stay readable.
const KEY_ID = 'k1'
const keys: Record<string, Buffer> = { [KEY_ID]: Buffer.from(env.ENCRYPTION_KEY, 'base64') }

/**
 * AES-256-GCM. `context` names where the value lives (such as `entries.text:<id>`), so a value
 * copied into another row or column fails to decrypt instead of showing the wrong text.
 */
export function encrypt(plain: string, context: string) {
	const iv = randomBytes(12)
	const cipher = createCipheriv('aes-256-gcm', keys[KEY_ID]!, iv)
	cipher.setAAD(Buffer.from(context))
	const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
	return [KEY_ID, iv, cipher.getAuthTag(), ct].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.')
}

export function decrypt(stored: string, context: string) {
	const [keyId, iv, tag, ct] = stored.split('.')
	const key = keys[keyId ?? '']
	if (!key || !iv || !tag || ct === undefined) throw new Error('Unreadable encrypted value')
	const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'))
	decipher.setAAD(Buffer.from(context))
	decipher.setAuthTag(Buffer.from(tag, 'base64url'))
	return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8')
}
