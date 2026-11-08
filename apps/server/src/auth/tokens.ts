import { createHash, randomBytes } from 'node:crypto'

/** 256 random bits; only its hash is stored, so a leaked table can't be used to sign in. */
export const newToken = () => randomBytes(32).toString('base64url')
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')
