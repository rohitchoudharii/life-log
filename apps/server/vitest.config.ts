import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { defineConfig } from 'vitest/config'

// Integration tests use their own database, created on first run, with the database accounts
// from .env, because accounts are shared by every database on the server.
const local = parseEnv(readFileSync(new URL('.env', import.meta.url), 'utf8'))
const onTestDatabase = (url: string | undefined) => Object.assign(new URL(url!), { pathname: '/lifelog_test' }).toString()

export default defineConfig({
	test: {
		env: {
			NODE_ENV: 'test',
			DATABASE_OWNER_URL: onTestDatabase(local.DATABASE_OWNER_URL),
			DATABASE_URL: onTestDatabase(local.DATABASE_URL),
			ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
			// The test site in src/import/test-site.ts.
			IMPORT_ALLOWED_ORIGINS: 'http://localhost:8796',
			IMPORT_PAGE_DELAY_MS: '0',
			// The test site also answers as the AI provider, with the reply a test gives it.
			ANTHROPIC_BASE_URL: 'http://localhost:8796',
			OPENAI_BASE_URL: 'http://localhost:8796',
		},
		fileParallelism: false,
	},
})
