import { pool } from './db/client'
import { os } from './orpc'
import { aiRoutes } from './routes/ai'
import { auth } from './routes/auth'
import { booksRoutes } from './routes/books'
import { devices } from './routes/devices'
import { entriesRoutes } from './routes/entries'
import { preferencesRoutes } from './routes/preferences'
import { mindRoutes, progressRoutes } from './routes/progress'
import { readingsRoutes } from './routes/readings'
import { recallRoutes } from './routes/recall'
import { questionRoutes, reviewRoutes } from './routes/review'
import { wordRoutes } from './routes/words'

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
	review: reviewRoutes,
	questions: questionRoutes,
	readings: readingsRoutes,
	books: booksRoutes,
	ai: aiRoutes,
	preferences: preferencesRoutes,
	mind: mindRoutes,
	progress: progressRoutes,
	recall: recallRoutes,
	words: wordRoutes,
})
