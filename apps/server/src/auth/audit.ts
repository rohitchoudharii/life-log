import { db } from '../db/client'
import { auditLog } from '../db/schema'

export type AuditEvent =
	| 'invite.created'
	| 'password.set'
	| 'signin'
	| 'signin.failed'
	| 'signin.locked'
	| 'signout'
	| 'device.signed-out'

export type RequestInfo = { ip: string | null; userAgent: string | null }

export async function audit(
	event: AuditEvent,
	who: { userId?: string | null; email?: string | null },
	req: RequestInfo | null,
	meta?: Record<string, unknown>,
) {
	await db.insert(auditLog).values({
		event,
		userId: who.userId ?? null,
		email: who.email ?? null,
		ip: req?.ip ?? null,
		userAgent: req?.userAgent ?? null,
		meta: meta ?? null,
	})
}
