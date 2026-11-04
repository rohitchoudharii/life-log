import { and, eq, gt } from 'drizzle-orm'
import type { Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import { HTTPException } from 'hono/http-exception'
import type { z } from 'zod'
import { hashToken } from './crypto'
import { db, t } from './db'

export type User = typeof t.users.$inferSelect
export type AppEnv = { Variables: { user: User } }

export async function parseBody<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
	const json = await c.req.json().catch(() => undefined)
	const parsed = schema.safeParse(json)
	if (!parsed.success) throw new HTTPException(400, { message: parsed.error.issues[0]?.message ?? 'Invalid request' })
	return parsed.data
}

export const requireUser = createMiddleware<AppEnv>(async (c, next) => {
	const token = c.req.header('authorization')?.match(/^Bearer (.+)$/)?.[1]
	if (!token) throw new HTTPException(401, { message: 'Sign in first' })
	const [row] = await db
		.select({ user: t.users })
		.from(t.sessions)
		.innerJoin(t.users, eq(t.users.id, t.sessions.userId))
		.where(and(eq(t.sessions.tokenHash, hashToken(token)), gt(t.sessions.expiresAt, new Date())))
	if (!row) throw new HTTPException(401, { message: 'Your session expired. Sign in again.' })
	c.set('user', row.user)
	await next()
})

export function isTimeZone(tz: string) {
	try {
		new Intl.DateTimeFormat('en', { timeZone: tz })
		return true
	} catch {
		return false
	}
}
