import { and, count, eq, gte, isNull } from 'drizzle-orm'
import { serialize } from 'hono/utils/cookie'
import { db } from '../db/client'
import { auditLog, sessions, users } from '../db/schema'
import { env } from '../env'
import { audit, type RequestInfo } from './audit'
import { deviceLabel } from './device-label'
import { hashToken, newToken } from './tokens'

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

export const SESSION_COOKIE = 'llc_session'
/** A device that hasn't been used for this long must sign in again. Use keeps it signed in. */
export const IDLE_LIMIT_MS = 30 * DAY

export type SessionUser = typeof users.$inferSelect
export type Session = typeof sessions.$inferSelect
export type SessionCheck =
	| { kind: 'none' }
	| { kind: 'expired' }
	| { kind: 'ok'; session: Session; user: SessionUser }

export async function createSession(userId: string, req: RequestInfo) {
	const token = newToken()
	await db.insert(sessions).values({ userId, tokenHash: hashToken(token), label: deviceLabel(req.userAgent) })
	return token
}

export async function loadSession(token: string | undefined, now = new Date()): Promise<SessionCheck> {
	if (!token) return { kind: 'none' }
	const [row] = await db
		.select({ session: sessions, user: users })
		.from(sessions)
		.innerJoin(users, eq(users.id, sessions.userId))
		.where(and(eq(sessions.tokenHash, hashToken(token)), isNull(sessions.revokedAt)))
	if (!row || row.user.disabledAt) return { kind: 'none' }
	const idle = now.getTime() - row.session.lastSeenAt.getTime()
	if (idle > IDLE_LIMIT_MS) {
		await db.update(sessions).set({ revokedAt: now }).where(eq(sessions.id, row.session.id))
		await audit('session.expired', { userId: row.user.id, email: row.user.email }, null)
		return { kind: 'expired' }
	}
	// Each use moves the 30 days forward. Writing once a minute is enough.
	if (idle > MINUTE) await db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, row.session.id))
	return { kind: 'ok', session: row.session, user: row.user }
}

export async function revokeSession(id: string) {
	await db
		.update(sessions)
		.set({ revokedAt: new Date() })
		.where(and(eq(sessions.id, id), isNull(sessions.revokedAt)))
}

export function sessionCookie(token: string | null) {
	return serialize(SESSION_COOKIE, token ?? '', {
		httpOnly: true,
		sameSite: 'Strict',
		secure: env.NODE_ENV === 'production',
		path: '/',
		// Browsers cap cookies at 400 days; the 30-day idle rule is enforced on the server.
		maxAge: token ? 400 * 24 * 60 * 60 : 0,
	})
}

const LOCK_WINDOW_MS = 15 * MINUTE
const MAX_FAILURES_PER_EMAIL = 5
const MAX_FAILURES_PER_IP = 20

/** True after too many wrong passwords for this email, or from this address, in the last 15 minutes. */
export async function signInLocked(email: string, ip: string | null, now = new Date()) {
	const since = new Date(now.getTime() - LOCK_WINDOW_MS)
	const failures = (where: ReturnType<typeof eq>) =>
		db
			.select({ n: count() })
			.from(auditLog)
			.where(and(eq(auditLog.event, 'signin.failed'), gte(auditLog.at, since), where))
			.then(([r]) => r?.n ?? 0)
	if ((await failures(eq(auditLog.email, email))) >= MAX_FAILURES_PER_EMAIL) return true
	return ip !== null && (await failures(eq(auditLog.ip, ip))) >= MAX_FAILURES_PER_IP
}

