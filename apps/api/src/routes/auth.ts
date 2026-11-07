import { getConnInfo } from '@hono/node-server/conninfo'
import { and, count, desc, eq, gt, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import { hashOtp, hashToken, newOtpCode, newSessionToken, safeEqualHex } from '../crypto'
import { db, t } from '../db'
import { email as mailer } from '../email'
import { isTimeZone, parseBody, requireUser, type AppEnv } from '../http'

const CODE_TTL_MS = 10 * 60 * 1000
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
const MAX_CODES_PER_EMAIL_PER_HOUR = 5
const MAX_REQUESTS_PER_IP_PER_HOUR = 20
const MAX_ATTEMPTS_PER_CODE = 5

const Email = z.string().trim().toLowerCase().pipe(z.email('Enter a valid email'))

// In-memory per-IP limit. Good for one API process; move to Postgres or Redis when scaling out.
const ipHits = new Map<string, number[]>()
function limitIp(ip: string) {
	const hourAgo = Date.now() - 3_600_000
	const hits = (ipHits.get(ip) ?? []).filter((at) => at > hourAgo)
	if (hits.length >= MAX_REQUESTS_PER_IP_PER_HOUR) throw new HTTPException(429, { message: 'Too many requests. Try again later.' })
	ipHits.set(ip, [...hits, Date.now()])
}

export const auth = new Hono<AppEnv>()
	.post('/otp/request', async (c) => {
		const { email } = await parseBody(c, z.object({ email: Email }))
		limitIp(getConnInfo(c).remote.address ?? 'unknown')
		const [recent] = await db
			.select({ n: count() })
			.from(t.otpCodes)
			.where(and(eq(t.otpCodes.email, email), gt(t.otpCodes.createdAt, new Date(Date.now() - 3_600_000))))
		if ((recent?.n ?? 0) >= MAX_CODES_PER_EMAIL_PER_HOUR)
			throw new HTTPException(429, { message: 'Too many codes requested. Try again in an hour.' })

		const code = newOtpCode()
		await db.insert(t.otpCodes).values({ email, codeHash: hashOtp(email, code), expiresAt: new Date(Date.now() + CODE_TTL_MS) })
		await mailer.send(email, 'Your Life Log Club sign-in code', `Your code is ${code}. It expires in 10 minutes.`)
		// Same reply whether or not the account exists, so the endpoint does not reveal who signed up.
		return c.json({ ok: true })
	})
	.post('/otp/verify', async (c) => {
		const { email, code, timezone } = await parseBody(
			c,
			z.object({ email: Email, code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code'), timezone: z.string().optional() }),
		)
		const [otp] = await db
			.select()
			.from(t.otpCodes)
			.where(and(eq(t.otpCodes.email, email), isNull(t.otpCodes.consumedAt), gt(t.otpCodes.expiresAt, new Date())))
			.orderBy(desc(t.otpCodes.createdAt))
			.limit(1)
		const invalid = new HTTPException(400, { message: 'That code is wrong or expired. Request a new one.' })
		if (!otp || otp.attempts >= MAX_ATTEMPTS_PER_CODE) throw invalid
		if (!safeEqualHex(otp.codeHash, hashOtp(email, code))) {
			await db.update(t.otpCodes).set({ attempts: otp.attempts + 1 }).where(eq(t.otpCodes.id, otp.id))
			throw invalid
		}
		await db.update(t.otpCodes).set({ consumedAt: new Date() }).where(eq(t.otpCodes.id, otp.id))

		const tz = timezone && isTimeZone(timezone) ? timezone : undefined
		const [user] = await db
			.insert(t.users)
			.values({ email, ...(tz && { timezone: tz }) })
			.onConflictDoUpdate({ target: t.users.email, set: tz ? { timezone: tz } : { email } })
			.returning()
		const token = newSessionToken()
		await db.insert(t.sessions).values({ userId: user!.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + SESSION_TTL_MS) })
		return c.json({ token })
	})
	.post('/logout', requireUser, async (c) => {
		const token = c.req.header('authorization')!.slice('Bearer '.length)
		await db.delete(t.sessions).where(eq(t.sessions.tokenHash, hashToken(token)))
		return c.json({ ok: true })
	})
