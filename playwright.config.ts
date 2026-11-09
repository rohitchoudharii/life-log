import { defineConfig, devices } from '@playwright/test'
import { API_PORT, e2eEnv, FAKE_LLM_PORT, FAKE_SITE_PORT, GOOD_ANTHROPIC_KEY, GOOD_OPENAI_KEY, WEB_PORT } from './e2e/env'

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
			command: 'node e2e/fake-llm.ts',
			url: `http://localhost:${FAKE_LLM_PORT}/health`,
			env: { PORT: String(FAKE_LLM_PORT), GOOD_ANTHROPIC_KEY, GOOD_OPENAI_KEY },
			reuseExistingServer: false,
		},
		{
			command: 'node e2e/fake-site.ts',
			url: `http://localhost:${FAKE_SITE_PORT}/health`,
			env: { PORT: String(FAKE_SITE_PORT) },
			reuseExistingServer: false,
		},
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
