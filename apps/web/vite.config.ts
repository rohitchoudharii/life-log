import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
	plugins: [react(), tailwindcss()],
	server: {
		proxy: { '/rpc': process.env.API_URL ?? 'http://localhost:8787', '/media': process.env.API_URL ?? 'http://localhost:8787' },
	},
})
