import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, Outlet } from '@tanstack/react-router'
import { orpc } from '../rpc'
import { SignIn } from './sign-in'

/** Shows the sign-in page until there is a session, then the app around the current page. */
export function SignedIn() {
	const me = useQuery(orpc.auth.me.queryOptions())
	const queryClient = useQueryClient()
	const signOut = useMutation(orpc.auth.signOut.mutationOptions({ onSuccess: () => queryClient.resetQueries() }))
	if (me.isPending) return null
	if (!me.data?.user) return <SignIn reason={me.data?.reason} />
	const nav = 'rounded-lg px-3 py-1.5 text-sm hover:bg-ink/5 [&.active]:bg-navy [&.active]:text-white'
	return (
		<div className="min-h-dvh">
			<header className="flex flex-wrap items-center gap-2 border-b border-ink/10 bg-white px-4 py-3">
				<img src="/logo.png" alt="" className="size-8 rounded-lg" />
				<span className="mr-auto font-serif text-lg text-navy">Life Log Club</span>
				<nav className="flex items-center gap-1">
					<Link to="/" className={nav}>
						Home
					</Link>
					<Link to="/devices" className={nav}>
						Devices
					</Link>
					<button type="button" className={nav} onClick={() => signOut.mutate({})}>
						Sign out
					</button>
				</nav>
			</header>
			<main className="mx-auto max-w-3xl px-4 py-8">
				<Outlet />
			</main>
		</div>
	)
}

export function Home() {
	const me = useQuery(orpc.auth.me.queryOptions())
	return <h1 className="text-2xl font-semibold">Welcome, {me.data?.user?.name}</h1>
}
