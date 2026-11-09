import { defineConfig } from 'wxt'

// The Life Log Club app the extension saves to. The member's session in that app signs the
// extension in: Chrome sends the app's cookie with the extension's requests, because the
// extension has access to the app's site.
const appOrigin = new URL(process.env.WXT_APP_ORIGIN ?? 'http://localhost:5173').origin
// The e2e build may also reach the test sites, since its popup is opened as a page, without the
// access a click on the toolbar button gives to the tab.
const testSites = (process.env.WXT_E2E_SITES ?? '').split(',').filter(Boolean)

export default defineConfig({
	modules: ['@wxt-dev/module-react'],
	publicDir: 'icons',
	// A visible folder, so Chrome's Load unpacked file picker shows it without revealing hidden files.
	outDir: 'dist',
	vite: () => ({ define: { __APP_ORIGIN__: JSON.stringify(appOrigin) } }),
	manifest: ({ mode }) => ({
		name: 'Life Log Club',
		description: 'Save the page you are reading to Life Log Club, on its own or as the next chapter of a book.',
		permissions: ['activeTab', 'scripting'],
		host_permissions: [`${appOrigin}/*`, ...(mode === 'e2e' ? testSites.map((s) => `${new URL(s).origin}/*`) : [])],
		icons: { 16: 'icon-16.png', 32: 'icon-32.png', 48: 'icon-48.png', 128: 'icon-128.png' },
		action: { default_title: 'Save to Life Log Club' },
	}),
})
