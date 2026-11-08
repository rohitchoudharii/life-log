import { z } from 'zod'

const Env = z.object({
	NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
	PORT: z.coerce.number().int().default(8787),
	DATABASE_OWNER_URL: z.url(),
	DATABASE_URL: z.url(),
	APP_ORIGIN: z.url().default('http://localhost:5173'),
})

export const env = Env.parse(process.env)
