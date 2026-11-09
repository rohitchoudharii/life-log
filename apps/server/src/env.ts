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
	/**
	 * Origins on this machine that link imports may fetch, comma-separated, such as the e2e test
	 * site. Every other private address is refused. Only tests set this.
	 */
	IMPORT_ALLOWED_ORIGINS: z
		.string()
		.default('')
		.transform((v) => v.split(',').map((o) => o.trim()).filter(Boolean).map((o) => new URL(o).origin)),
}).refine((e) => e.NODE_ENV !== 'production' || !e.IMPORT_ALLOWED_ORIGINS.length, {
	message: 'IMPORT_ALLOWED_ORIGINS is for tests only; remove it in production',
	path: ['IMPORT_ALLOWED_ORIGINS'],
})

export const env = Env.parse(process.env)
