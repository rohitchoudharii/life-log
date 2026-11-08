import { ORPCError } from '@orpc/server'
import { and, eq, gt, isNull } from 'drizzle-orm'
import { audit } from '../auth/audit'
import { burnTime, hashPassword, verifyPassword } from '../auth/password'
import { createSession, loadSession, revokeSession, sessionCookie, signInLocked } from '../auth/sessions'
import { hashToken } from '../auth/tokens'
import { db } from '../db/client'
import { invites, sessions, users } from '../db/schema'
import { os } from '../orpc'

const toUser = (u: typeof users.$inferSelect) => ({ id: u.id, email: u.email, name: u.name })

const WRONG = 'Email or password is wrong.'

export const auth = {
	me: os.auth.me.handler(async ({ context }) => {
		const check = await loadSession(context.token)
		if (check.kind === 'ok') return { user: toUser(check.user), reason: null }
		if (context.token) context.resHeaders.append('set-cookie', sessionCookie(null))
		return { user: null, reason: check.kind === 'expired' ? 'expired' : 'signed-out' }
	}),

	acceptInvite: os.auth.acceptInvite.handler(async ({ input, context }) => {
		const passwordHash = await hashPassword(input.password)
		const user = await db.transaction(async (tx) => {
			const [invite] = await tx
				.update(invites)
				.set({ usedAt: new Date() })
				.where(
					and(
						eq(invites.tokenHash, hashToken(input.token)),
						isNull(invites.usedAt),
						gt(invites.expiresAt, new Date()),
					),
				)
				.returning()
			if (!invite)
				throw new ORPCError('BAD_REQUEST', {
					message: 'This invite link has expired or was already used. Ask for a new one.',
				})
			const [user] = await tx
				.insert(users)
				.values({ email: invite.email, name: input.name, passwordHash })
				.onConflictDoUpdate({ target: users.email, set: { name: input.name, passwordHash } })
				.returning()
			// A new password signs out every device that used the old one.
			await tx
				.update(sessions)
				.set({ revokedAt: new Date() })
				.where(and(eq(sessions.userId, user!.id), isNull(sessions.revokedAt)))
			return user!
		})
		await audit('password.set', { userId: user.id, email: user.email }, context.req)
		context.resHeaders.append('set-cookie', sessionCookie(await createSession(user.id, context.req)))
		return toUser(user)
	}),

	signIn: os.auth.signIn.handler(async ({ input, context }) => {
		const { email, password } = input
		if (await signInLocked(email, context.req.ip)) {
			await audit('signin.locked', { email }, context.req)
			throw new ORPCError('TOO_MANY_REQUESTS', {
				message: 'Too many wrong tries. Wait 15 minutes, then try again.',
			})
		}
		const [user] = await db.select().from(users).where(eq(users.email, email))
		const ok = user?.passwordHash && !user.disabledAt ? await verifyPassword(user.passwordHash, password) : false
		if (!user?.passwordHash) await burnTime(password)
		if (!user || !ok) {
			await audit('signin.failed', { userId: user?.id, email }, context.req)
			throw new ORPCError('UNAUTHORIZED', { message: WRONG })
		}
		await audit('signin', { userId: user.id, email }, context.req)
		context.resHeaders.append('set-cookie', sessionCookie(await createSession(user.id, context.req)))
		return toUser(user)
	}),

	signOut: os.auth.signOut.handler(async ({ context }) => {
		const check = await loadSession(context.token)
		if (check.kind === 'ok') {
			await revokeSession(check.session.id)
			await audit('signout', { userId: check.user.id, email: check.user.email }, context.req)
		}
		context.resHeaders.append('set-cookie', sessionCookie(null))
		return { ok: true as const }
	}),
}
