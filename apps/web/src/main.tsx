import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { orpc } from './rpc'
import './styles.css'

const queryClient = new QueryClient()

function Status() {
	const health = useQuery(orpc.system.health.queryOptions())
	if (health.isPending) return <p>Checking…</p>
	if (health.isError) return <p>Server unreachable</p>
	return (
		<p>
			server {health.data.server}, database {health.data.database}
		</p>
	)
}

createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<QueryClientProvider client={queryClient}>
			<main className="p-8 font-sans">
				<h1 className="text-2xl">Life Log Club</h1>
				<Status />
			</main>
		</QueryClientProvider>
	</StrictMode>,
)
