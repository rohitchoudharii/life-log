import { defineConfig, devices } from '@playwright/test'

// End-to-end tests run their own API and web servers on separate ports, against a separate
// database, so they never touch development data.
const API_PORT = 8788
const WEB_PORT = 5174
export const e2eEnv = {
	NODE_ENV: 'test',
	PORT: String(API_PORT),
	DATABASE_OWNER_URL: 'postgres://peak:peak@localhost:5544/lifelog_e2e',
	DATABASE_URL: 'postgres://lifelog_app:lifelog_app@localhost:5544/lifelog_e2e',
	APP_ORIGIN: `http://localhost:${WEB_PORT}`,
}

export default defineConfig({
	testDir: 'e2e',
	fullyParallel: true,
	reporter: 'list',
	use: { baseURL: `http://localhost:${WEB_PORT}`, trace: 'retain-on-failure' },
	projects: [
		{ name: 'desktop', use: { ...devices['Desktop Chrome'] } },
		{ name: 'phone', use: { ...devices['Pixel 7'] } },
	],
	webServer: [
		{
			command: 'pnpm --filter @life-log-club/server start',
			url: `http://localhost:${API_PORT}/health`,
			env: e2eEnv,
			reuseExistingServer: false,
			stdout: 'pipe',
		},
		{
			command: `pnpm --filter @life-log-club/web exec vite --port ${WEB_PORT} --strictPort`,
			url: `http://localhost:${WEB_PORT}`,
			env: { API_URL: `http://localhost:${API_PORT}` },
			reuseExistingServer: false,
		},
	],
})
