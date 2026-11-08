import { contract } from '@life-log-club/contract'
import { implement } from '@orpc/server'
import { pool } from './db/client'

const os = implement(contract)

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
})
