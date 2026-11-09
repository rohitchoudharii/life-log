import { getConnInfo } from '@hono/node-server/conninfo'
import { MAX_FILE_BYTES } from '@life-log-club/contract'
import { ORPCError, onError } from '@orpc/server'
import { BodyLimitPlugin, RPCHandler } from '@orpc/server/fetch'
import { SimpleCsrfProtectionHandlerPlugin } from '@orpc/server/plugins'
import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { loadSession, SESSION_COOKIE } from './auth/sessions'
import type { Context } from './context'
import { asUser } from './db/client'
import { media } from './db/schema'
import { router } from './router'

const rpc = new RPCHandler(router, {
	// The largest request is a book upload; room is left for the rest of the form.
	plugins: [new SimpleCsrfProtectionHandlerPlugin(), new BodyLimitPlugin({ maxBodySize: MAX_FILE_BYTES + 1024 * 1024 })],
	interceptors: [
		onError((error) => {
			// Expected client errors (bad input, not signed in) are answers, not failures.
			if (!(error instanceof ORPCError) || error.status >= 500) console.error(error)
		}),
	],
})

export const app = new Hono()

app.get('/health', (c) => c.json({ ok: true }))

app.use('/rpc/*', async (c, next) => {
	const context: Context = {
		token: getCookie(c, SESSION_COOKIE) || undefined,
		req: { ip: getConnInfo(c).remote.address ?? null, userAgent: c.req.header('user-agent') ?? null },
		resHeaders: new Headers(),
	}
	const { matched, response } = await rpc.handle(c.req.raw, { prefix: '/rpc', context })
	if (!matched) return next()
	const res = c.newResponse(response.body, response)
	for (const cookie of context.resHeaders.getSetCookie()) res.headers.append('set-cookie', cookie)
	res.headers.set('cache-control', 'no-store')
	return res
})

/**
 * A reading's image, for the member it belongs to. Images load with the session cookie like any
 * page request; row-level security hides other members' images. The headers keep the bytes from
 * ever being run as a page.
 */
app.get('/media/:id', async (c) => {
	const id = c.req.param('id')
	if (!z.uuid().safeParse(id).success) return c.notFound()
	const session = await loadSession(getCookie(c, SESSION_COOKIE) || undefined)
	if (session.kind !== 'ok') return c.body(null, 401)
	const [row] = await asUser(session.user.id, (tx) =>
		tx.select({ contentType: media.contentType, data: media.data }).from(media).where(eq(media.id, id)),
	)
	if (!row) return c.notFound()
	return c.body(new Uint8Array(row.data), 200, {
		'content-type': row.contentType,
		'x-content-type-options': 'nosniff',
		'content-security-policy': "default-src 'none'; sandbox",
		'cache-control': 'private, max-age=31536000, immutable',
	})
})
