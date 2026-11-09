import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'

// End-to-end tests run their own API and web servers on separate ports, against a separate
// database, so they never touch development data. They use the database accounts from
// apps/server/.env, because accounts are shared by every database on the server.
const local = parseEnv(readFileSync(new URL('../apps/server/.env', import.meta.url), 'utf8'))
const onTestDatabase = (url: string | undefined) => Object.assign(new URL(url!), { pathname: '/lifelog_e2e' }).toString()

export const API_PORT = 8788
export const WEB_PORT = 5174
export const FAKE_LLM_PORT = 8799
export const FAKE_SITE_PORT = 8797
/** The fake site's address, as a member would paste it. */
export const FAKE_SITE = `http://localhost:${FAKE_SITE_PORT}`
export const e2eEnv = {
	NODE_ENV: 'test',
	PORT: String(API_PORT),
	DATABASE_OWNER_URL: onTestDatabase(local.DATABASE_OWNER_URL),
	DATABASE_URL: onTestDatabase(local.DATABASE_URL),
	APP_ORIGIN: `http://localhost:${WEB_PORT}`,
	// A fixed key for test data only.
	ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
	ANTHROPIC_BASE_URL: `http://localhost:${FAKE_LLM_PORT}`,
	OPENAI_BASE_URL: `http://localhost:${FAKE_LLM_PORT}`,
	IMPORT_ALLOWED_ORIGINS: FAKE_SITE,
	// Short, but long enough to see a web book's progress.
	IMPORT_PAGE_DELAY_MS: '400',
}

/** The only keys the fake AI provider (e2e/fake-llm.ts) accepts. */
export const GOOD_ANTHROPIC_KEY = 'sk-ant-test-key-0001'
export const GOOD_OPENAI_KEY = 'sk-test-openai-key-0002'
