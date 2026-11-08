import { serve } from '@hono/node-server'
import { app } from './app'
import { prepareDatabase } from './db/prepare'
import { env } from './env'

await prepareDatabase()
serve({ fetch: app.fetch, port: env.PORT }, ({ port }) => console.log(`API on http://localhost:${port}`))
