import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Devices } from './pages/devices'
import { Settings } from './pages/settings'
import { Home } from './pages/home'
import { Welcome } from './pages/welcome'
import { Body, Heart, Mind } from './pages/worlds'
import { isUnauthorized, orpc } from './rpc'
import { SignedIn } from './shell'
import { ToastProvider } from './toast'
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
const mindRoute = createRoute({ getParentRoute: () => appRoute, path: '/mind', component: Mind })
const bodyRoute = createRoute({ getParentRoute: () => appRoute, path: '/body', component: Body })
const heartRoute = createRoute({ getParentRoute: () => appRoute, path: '/heart', component: Heart })
const settingsRoute = createRoute({ getParentRoute: () => appRoute, path: '/settings', component: Settings })

const router = createRouter({
	routeTree: rootRoute.addChildren([welcomeRoute, appRoute.addChildren([homeRoute, mindRoute, bodyRoute, heartRoute, devicesRoute, settingsRoute])]),
})

declare module '@tanstack/react-router' {
	interface Register {
		router: typeof router
	}
}

createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<QueryClientProvider client={queryClient}>
			<ToastProvider>
				<RouterProvider router={router} />
			</ToastProvider>
		</QueryClientProvider>
	</StrictMode>,
)
