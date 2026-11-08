import { ORPCError, onError } from '@orpc/server'
import { RPCHandler } from '@orpc/server/fetch'
import { SimpleCsrfProtectionHandlerPlugin } from '@orpc/server/plugins'
import { Hono } from 'hono'
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
	const { matched, response } = await rpc.handle(c.req.raw, { prefix: '/rpc', context: {} })
	if (matched) return c.newResponse(response.body, response)
	await next()
})
