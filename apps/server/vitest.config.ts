import { defineConfig } from 'vitest/config'

// Integration tests use their own database, created on first run.
export default defineConfig({
	test: {
		env: {
			NODE_ENV: 'test',
			DATABASE_OWNER_URL: 'postgres://peak:peak@localhost:5544/lifelog_test',
			DATABASE_URL: 'postgres://lifelog_app:lifelog_app@localhost:5544/lifelog_test',
			ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
		},
		fileParallelism: false,
	},
})
