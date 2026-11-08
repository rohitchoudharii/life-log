import { pool } from './db/client'
import { os } from './orpc'
import { auth } from './routes/auth'
import { devices } from './routes/devices'
import { entriesRoutes } from './routes/entries'

export const router = os.router({
	system: {
		health: os.system.health.handler(async () => {
			try {
				await pool.query('select 1')
				return { server: 'ok', database: 'ok' }
			} catch {
				return { server: 'ok', database: 'down' }
			}
		}),
	},
	auth,
	devices,
	entries: entriesRoutes,
})
