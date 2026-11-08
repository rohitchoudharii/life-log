import { argon2, randomBytes, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const derive = promisify(argon2)

// argon2id with 64 MiB of memory: slow enough to make guessing a leaked hash expensive,
// fast enough (about 50 ms) for a sign-in.
const PARAMS = { memory: 65536, passes: 3, parallelism: 4, tagLength: 32 }

async function compute(password: string, salt: Buffer, p: typeof PARAMS) {
	return derive('argon2id', { message: password, nonce: salt, ...p })
}

/** Returns a PHC string, such as `$argon2id$v=19$m=65536,t=3,p=4$<salt>$<hash>`. */
export async function hashPassword(password: string) {
	const salt = randomBytes(16)
	const hash = await compute(password, salt, PARAMS)
	const { memory: m, passes: t, parallelism: p } = PARAMS
	return `$argon2id$v=19$m=${m},t=${t},p=${p}$${salt.toString('base64url')}$${hash.toString('base64url')}`
}

export async function verifyPassword(stored: string, password: string) {
	const [, alg, , params, salt, hash] = stored.split('$')
	if (alg !== 'argon2id' || !params || !salt || !hash) return false
	const n = Object.fromEntries(params.split(',').map((kv) => kv.split('=') as [string, string]))
	const expected = Buffer.from(hash, 'base64url')
	const actual = await compute(password, Buffer.from(salt, 'base64url'), {
		memory: Number(n.m),
		passes: Number(n.t),
		parallelism: Number(n.p),
		tagLength: expected.length,
	})
	return timingSafeEqual(actual, expected)
}

// Hashing a throwaway password when the email is unknown keeps the response time the same,
// so timing doesn't reveal who has an account.
const decoy = hashPassword(randomBytes(16).toString('hex'))
export async function burnTime(password: string) {
	await verifyPassword(await decoy, password)
}
