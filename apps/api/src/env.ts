import { z } from 'zod'

const Env = z.object({
	DATABASE_URL: z.string().url(),
	/** 32 random bytes, base64. Wraps the per-key data keys for stored LLM API keys. */
	ENCRYPTION_KEY: z
		.string()
		.refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes, base64-encoded'),
	/** Secret used to hash one-time login codes. */
	OTP_SECRET: z.string().min(32),
	PORT: z.coerce.number().default(8787),
	/** Comma-separated origins allowed to call the API from a browser. */
	CORS_ORIGINS: z.string().default('http://localhost:8081'),
})

export const env = Env.parse(process.env)
