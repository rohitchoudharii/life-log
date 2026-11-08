import { z } from 'zod'

const Env = z.object({
	NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
	PORT: z.coerce.number().int().default(8787),
	DATABASE_OWNER_URL: z.url(),
	DATABASE_URL: z.url(),
	APP_ORIGIN: z.url().default('http://localhost:5173'),
	/** Encrypts private fields. Keep a copy outside the server: without it they can't be read. */
	ENCRYPTION_KEY: z
		.string()
		.refine((v) => Buffer.from(v, 'base64').length === 32, '32 random bytes in base64: openssl rand -base64 32'),
	/** Where the AI providers are reached. Only tests change these. */
	ANTHROPIC_BASE_URL: z.url().default('https://api.anthropic.com'),
	OPENAI_BASE_URL: z.url().default('https://api.openai.com'),
})

export const env = Env.parse(process.env)
