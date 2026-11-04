import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { db, t } from '../db'
import { isTimeZone, parseBody, requireUser, type AppEnv, type User } from '../http'

const view = (u: User) => ({ email: u.email, timezone: u.timezone, reminderTime: u.reminderTime, dailyReviewCap: u.dailyReviewCap })

export const me = new Hono<AppEnv>()
	.use(requireUser)
	.get('/', (c) => c.json(view(c.var.user)))
	.patch('/', async (c) => {
		const patch = await parseBody(
			c,
			z.object({
				reminderTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().optional(),
				dailyReviewCap: z.number().int().min(5).max(500).optional(),
				timezone: z.string().refine(isTimeZone, 'Unknown timezone').optional(),
			}),
		)
		const [user] = await db.update(t.users).set(patch).where(eq(t.users.id, c.var.user.id)).returning()
		return c.json(view(user!))
	})
