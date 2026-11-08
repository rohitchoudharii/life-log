import { z } from 'zod'
import { audit } from '../auth/audit'
import { hashToken, newToken } from '../auth/tokens'
import { pool, db } from '../db/client'
import { prepareDatabase } from '../db/prepare'
import { invites } from '../db/schema'
import { env } from '../env'

// Usage: pnpm invite someone@example.com
// Prints a link that lets that email set a password. Running it again for someone who already
// has an account gives them a link to reset their password.
const email = z.email().trim().toLowerCase().safeParse(process.argv[2])
if (!email.success) {
	console.error('Usage: pnpm invite someone@example.com')
	process.exit(1)
}

await prepareDatabase()
const token = newToken()
await db.insert(invites).values({
	email: email.data,
	tokenHash: hashToken(token),
	expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
})
await audit('invite.created', { email: email.data }, null)
await pool.end()
console.log(`Invite link for ${email.data}, valid for 7 days. Send it only to them:`)
console.log(`${env.APP_ORIGIN}/welcome#${token}`)
