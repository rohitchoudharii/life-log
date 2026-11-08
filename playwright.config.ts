import { defineConfig, devices } from '@playwright/test'
import { API_PORT, e2eEnv, WEB_PORT } from './e2e/env'

export default defineConfig({
	testDir: 'e2e',
	fullyParallel: true,
	reporter: 'list',
	globalSetup: './e2e/global-setup.ts',
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
