// End-to-end tests run their own API and web servers on separate ports, against a separate
// database, so they never touch development data.
export const API_PORT = 8788
export const WEB_PORT = 5174
export const e2eEnv = {
	NODE_ENV: 'test',
	PORT: String(API_PORT),
	DATABASE_OWNER_URL: 'postgres://peak:peak@localhost:5544/lifelog_e2e',
	DATABASE_URL: 'postgres://lifelog_app:lifelog_app@localhost:5544/lifelog_e2e',
	APP_ORIGIN: `http://localhost:${WEB_PORT}`,
	// A fixed key for test data only.
	ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
}
