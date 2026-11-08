import { getConnInfo } from '@hono/node-server/conninfo'
import { ORPCError, onError } from '@orpc/server'
import { RPCHandler } from '@orpc/server/fetch'
import { SimpleCsrfProtectionHandlerPlugin } from '@orpc/server/plugins'
import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import { SESSION_COOKIE } from './auth/sessions'
import type { Context } from './context'
import { router } from './router'

const rpc = new RPCHandler(router, {
	plugins: [new SimpleCsrfProtectionHandlerPlugin()],
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
