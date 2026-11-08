import { ORPCError } from '@orpc/server'
import { and, desc, eq, gt, isNull } from 'drizzle-orm'
import { audit } from '../auth/audit'
import { IDLE_LIMIT_MS, revokeSession, sessionCookie } from '../auth/sessions'
import { db } from '../db/client'
import { sessions } from '../db/schema'
import { authed } from '../orpc'

export const devices = {
	list: authed.devices.list.handler(async ({ context }) => {
		const rows = await db
			.select()
			.from(sessions)
			.where(
				and(
					eq(sessions.userId, context.user.id),
					isNull(sessions.revokedAt),
					gt(sessions.lastSeenAt, new Date(Date.now() - IDLE_LIMIT_MS)),
				),
			)
			.orderBy(desc(sessions.lastSeenAt))
		return rows.map((s) => ({
			id: s.id,
			label: s.label,
			current: s.id === context.session.id,
			createdAt: s.createdAt,
			lastSeenAt: s.lastSeenAt,
		}))
	}),

	signOut: authed.devices.signOut.handler(async ({ input, context }) => {
		const [target] = await db
			.select({ id: sessions.id, label: sessions.label })
			.from(sessions)
			.where(and(eq(sessions.id, input.id), eq(sessions.userId, context.user.id)))
		if (!target) throw new ORPCError('NOT_FOUND', { message: 'That device is not signed in.' })
		await revokeSession(target.id)
		await audit('device.signed-out', { userId: context.user.id, email: context.user.email }, context.req, {
			sessionId: target.id,
			label: target.label,
		})
		if (target.id === context.session.id) context.resHeaders.append('set-cookie', sessionCookie(null))
		return { ok: true as const }
	}),
}
