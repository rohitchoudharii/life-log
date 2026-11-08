import { serve } from '@hono/node-server'
import { app } from './app'
import { prepareDatabase } from './db/prepare'
import { env } from './env'
import { startJobs } from './jobs'

await prepareDatabase()
const jobs = await startJobs()
const server = serve({ fetch: app.fetch, port: env.PORT }, ({ port }) => console.log(`API on http://localhost:${port}`))

for (const signal of ['SIGINT', 'SIGTERM'] as const)
	process.once(signal, () => {
		server.close()
		void jobs.stop({ graceful: true, timeout: 5000 }).finally(() => process.exit(0))
	})
