import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { HTTPException } from 'hono/http-exception'
import { runMigrations } from './db'
import { env } from './env'
import { startJobs } from './jobs'
import { auth } from './routes/auth'
import { library } from './routes/library'
import { llm } from './routes/llm'
import { me } from './routes/me'
import { notes } from './routes/notes'
import { words } from './routes/words'
import { recall } from './routes/recall'
import { sessions } from './routes/sessions'
import { study } from './routes/study'
import { books } from './routes/books'
import { mediaRoute, startLinkImports, web } from './routes/web'

const app = new Hono()
	.use(cors({ origin: env.CORS_ORIGINS.split(',').map((o) => o.trim()) }))
	.get('/health', (c) => c.json({ ok: true }))
	// Before the signed-in routes: images load in <img> tags, which cannot send the session header.
	.route('/', mediaRoute)
	.route('/auth', auth)
	.route('/me', me)
	.route('/llm-key', llm)
	.route('/items', library)
	.route('/', sessions)
	.route('/', recall)
	.route('/', study)
	.route('/', web)
	.route('/', books)
	.route('/', notes)
	.route('/', words)
	.onError((err, c) => {
		if (err instanceof HTTPException) return c.json({ error: err.message }, err.status)
		console.error(err)
		return c.json({ error: 'Something went wrong' }, 500)
	})

await runMigrations()
await startJobs()
await startLinkImports()
serve({ fetch: app.fetch, port: env.PORT, hostname: '0.0.0.0' }, (info) => console.log(`API on http://localhost:${info.port}`))
