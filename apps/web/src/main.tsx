import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Devices } from './pages/devices'
import { Home, SignedIn } from './pages/signed-in'
import { Welcome } from './pages/welcome'
import { isUnauthorized, orpc } from './rpc'
import './styles.css'

// When any call finds the session gone (signed out from another device, or 30 days away),
// ask the server again, so the sign-in page appears with the reason.
const onError = (error: unknown) => {
	if (isUnauthorized(error)) void queryClient.invalidateQueries({ queryKey: orpc.auth.me.key() })
}
const queryClient = new QueryClient({
	queryCache: new QueryCache({ onError }),
	mutationCache: new MutationCache({ onError }),
	defaultOptions: { queries: { retry: (n, error) => !isUnauthorized(error) && n < 2 } },
})

const rootRoute = createRootRoute({ component: Outlet })
const welcomeRoute = createRoute({ getParentRoute: () => rootRoute, path: '/welcome', component: Welcome })
const appRoute = createRoute({ getParentRoute: () => rootRoute, id: 'app', component: SignedIn })
const homeRoute = createRoute({ getParentRoute: () => appRoute, path: '/', component: Home })
const devicesRoute = createRoute({ getParentRoute: () => appRoute, path: '/devices', component: Devices })

const router = createRouter({
	routeTree: rootRoute.addChildren([welcomeRoute, appRoute.addChildren([homeRoute, devicesRoute])]),
})

declare module '@tanstack/react-router' {
	interface Register {
		router: typeof router
	}
}

createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<QueryClientProvider client={queryClient}>
			<RouterProvider router={router} />
		</QueryClientProvider>
	</StrictMode>,
)
