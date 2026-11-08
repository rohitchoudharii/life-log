// End-to-end tests run their own API and web servers on separate ports, against a separate
// database, so they never touch development data.
export const API_PORT = 8788
export const WEB_PORT = 5174
export const FAKE_LLM_PORT = 8799
export const e2eEnv = {
	NODE_ENV: 'test',
	PORT: String(API_PORT),
	DATABASE_OWNER_URL: 'postgres://peak:peak@localhost:5544/lifelog_e2e',
	DATABASE_URL: 'postgres://lifelog_app:lifelog_app@localhost:5544/lifelog_e2e',
	APP_ORIGIN: `http://localhost:${WEB_PORT}`,
	// A fixed key for test data only.
	ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
	ANTHROPIC_BASE_URL: `http://localhost:${FAKE_LLM_PORT}`,
	OPENAI_BASE_URL: `http://localhost:${FAKE_LLM_PORT}`,
}

/** The only keys the fake AI provider (e2e/fake-llm.ts) accepts. */
export const GOOD_ANTHROPIC_KEY = 'sk-ant-test-key-0001'
export const GOOD_OPENAI_KEY = 'sk-test-openai-key-0002'
