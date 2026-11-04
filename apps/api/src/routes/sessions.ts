import { and, eq, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import { db, t } from '../db'
import { parseBody, requireUser, type AppEnv } from '../http'
import { ownItem } from './library'

async function ownSession(userId: string, sessionId: string) {
	if (!z.uuid().safeParse(sessionId).success) throw new HTTPException(404, { message: 'Not found' })
	const [s] = await db
		.select()
		.from(t.studySessions)
		.where(and(eq(t.studySessions.id, sessionId), eq(t.studySessions.userId, userId)))
	if (!s) throw new HTTPException(404, { message: 'Not found' })
	return s
}

/** Focus sessions only measure time; the user picks what to be tested on when they stop. */
export const sessions = new Hono<AppEnv>()
	.use(requireUser)
	// Only one session runs at a time; starting another ends the unfinished one.
	.post('/items/:id/sessions', async (c) => {
		const user = c.var.user
		const item = await ownItem(user.id, c.req.param('id'))
		const { plannedMinutes } = await parseBody(c, z.object({ plannedMinutes: z.number().int().min(5).max(90) }))
		const session = await db.transaction(async (tx) => {
			await tx
				.update(t.studySessions)
				.set({ endedAt: new Date() })
				.where(and(eq(t.studySessions.userId, user.id), isNull(t.studySessions.endedAt)))
			const [s] = await tx.insert(t.studySessions).values({ userId: user.id, itemId: item.id, plannedMinutes }).returning()
			return s!
		})
		return c.json({ session }, 201)
	})
	.post('/sessions/:id/finish', async (c) => {
		const s = await ownSession(c.var.user.id, c.req.param('id'))
		const [session] = await db
			.update(t.studySessions)
			.set({ endedAt: s.endedAt ?? new Date() })
			.where(eq(t.studySessions.id, s.id))
			.returning()
		return c.json({ session: session! })
	})
	// A cancelled session was not focus time, so it is removed rather than ended.
	.delete('/sessions/:id', async (c) => {
		const s = await ownSession(c.var.user.id, c.req.param('id'))
		await db.delete(t.studySessions).where(eq(t.studySessions.id, s.id))
		return c.json({ ok: true })
	})
