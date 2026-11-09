import type { User } from '@life-log-club/contract'
import type { EntryType } from '@life-log-club/domain'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router'
import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { LogDialog } from './log-dialog'
import { SignIn } from './pages/sign-in'
import { orpc } from './rpc'

export type World = 'home' | 'mind' | 'body' | 'heart'

const WORLDS: { world: World; to: '/' | '/mind' | '/body' | '/heart'; label: string; title: string; dot: string }[] = [
	{ world: 'home', to: '/', label: 'Home', title: 'Your four worlds', dot: 'bg-cream' },
	{ world: 'mind', to: '/mind', label: 'Mind', title: 'The reading room', dot: 'bg-mind' },
	{ world: 'body', to: '/body', label: 'Body', title: 'The training log', dot: 'bg-body' },
	{ world: 'heart', to: '/heart', label: 'Heart', title: 'The journal', dot: 'bg-heart' },
]

const OpenLog = createContext<(type?: EntryType) => void>(() => {})
/** Opens the + Log dialog, on a given type or on the last one used. */
export const useOpenLog = () => useContext(OpenLog)

/** Shows the sign-in page until there is a session, then the app around the current page. */
export function SignedIn() {
	const me = useQuery(orpc.auth.me.queryOptions())
	if (me.isPending) return null
	if (!me.data?.user) return <SignIn reason={me.data?.reason} />
	return <Shell user={me.data.user} />
}

export function useSignOut() {
	const queryClient = useQueryClient()
	return useMutation(orpc.auth.signOut.mutationOptions({ onSuccess: () => queryClient.resetQueries() }))
}

function Shell({ user }: { user: User }) {
	const navigate = useNavigate()
	const path = useRouterState({ select: (s) => s.location.pathname })
	const current = WORLDS.find((w) => w.to !== '/' && path.startsWith(w.to)) ?? WORLDS[0]!
	const [logType, setLogType] = useState<EntryType | null>(null)
	const lastType = useRef<EntryType>('gym.set')
	const openLog = (type?: EntryType) => {
		if (type) lastType.current = type
		setLogType(type ?? lastType.current)
	}
	const signOut = useSignOut()

	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return
			if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"], dialog')) return
			if (e.key === 'l' || e.key === 'L') {
				e.preventDefault()
				setLogType(lastType.current)
			}
			const target = WORLDS[Number(e.key) - 1]
			if (target) void navigate({ to: target.to })
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [navigate])

	const title = path === '/settings' ? 'Settings' : path === '/devices' ? 'Devices' : current.title

	return (
		<OpenLog value={openLog}>
			<div data-world={current.world} className="min-h-dvh md:grid md:grid-cols-[15rem_minmax(0,1fr)]">
				<aside className="sticky top-0 hidden h-dvh flex-col gap-1 bg-navy p-4 font-sans text-white md:flex">
					<Link to="/" className="mb-6 flex items-center gap-3 px-2">
						<img src="/logo.png" alt="" className="size-10 rounded-xl" />
						<span className="font-serif text-lg leading-tight">Life Log Club</span>
					</Link>
					<nav aria-label="Worlds" className="grid gap-1">
						{WORLDS.map((w, i) => (
							<Link
								key={w.to}
								to={w.to}
								activeOptions={{ exact: w.to === '/' }}
								className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-white/75 transition hover:bg-white/10 hover:text-white [&.active]:bg-white/15 [&.active]:text-white"
							>
								<span className={`size-2.5 rounded-full ${w.dot}`} />
								<span className="flex-1">{w.label}</span>
								<kbd className="text-xs text-white/40">{i + 1}</kbd>
							</Link>
						))}
						<span aria-disabled className="flex items-center gap-3 px-3 py-2 text-sm text-white/35">
							<span className="size-2.5 rounded-full bg-path/60" />
							<span className="flex-1">Path</span>
							<span className="text-xs">later</span>
						</span>
					</nav>
					<div className="mt-auto grid gap-1 border-t border-white/10 pt-3 text-sm">
						<Link to="/settings" className="rounded-lg px-3 py-2 text-white/75 hover:bg-white/10 hover:text-white [&.active]:bg-white/15">
							Settings
						</Link>
						<button type="button" onClick={() => signOut.mutate({})} className="rounded-lg px-3 py-2 text-left text-white/75 hover:bg-white/10 hover:text-white">
							Sign out
						</button>
						<p className="px-3 pt-2 text-xs text-white/40">
							<kbd>L</kbd> log · <kbd>1</kbd>–<kbd>4</kbd> worlds
						</p>
					</div>
				</aside>

				<div className="flex min-w-0 flex-col">
					<header className="sticky top-0 z-20 flex items-center gap-3 border-b border-world-line bg-world/90 px-4 py-3 backdrop-blur md:px-8">
						<Link to="/" className="md:hidden" aria-label="Home">
							<img src="/logo.png" alt="" className="size-9 rounded-lg" />
						</Link>
						<p className="mr-auto truncate text-sm text-world-muted">
							<span className={`mr-2 inline-block size-2 rounded-full align-middle ${current.dot}`} />
							{title}
						</p>
						<button
							type="button"
							onClick={() => openLog()}
							className="hidden items-center gap-2 rounded-lg bg-red px-4 py-2 font-sans text-sm font-semibold text-white shadow-sm transition hover:bg-red/90 active:scale-[0.97] md:flex"
						>
							+ Log <kbd className="rounded border border-white/40 px-1 text-xs font-normal">L</kbd>
						</button>
						<Link
							to="/settings"
							aria-label="Account"
							title={`${user.name} · Settings`}
							className="grid size-9 place-items-center rounded-full bg-navy font-sans text-sm font-semibold text-white"
						>
							{user.name.slice(0, 1).toUpperCase()}
						</Link>
					</header>
					{/* The reader uses the whole width: its contents sit at the left, the text where the member sets it. */}
					<main className={`mx-auto w-full flex-1 px-4 pt-6 pb-28 md:px-8 md:pb-12 ${path.startsWith('/mind/read/') ? '' : 'max-w-5xl'}`}>
						<Outlet />
					</main>
				</div>

				<nav aria-label="Worlds" className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 items-end bg-navy px-2 pt-2 pb-[max(env(safe-area-inset-bottom),0.5rem)] font-sans text-white md:hidden">
					{WORLDS.flatMap((w, i) => {
						const link = (
							<Link
								key={w.to}
								to={w.to}
								activeOptions={{ exact: w.to === '/' }}
								className="grid justify-items-center gap-1 py-1 text-xs text-white/60 [&.active]:text-white"
							>
								<span className={`size-3 rounded-full ${w.dot}`} />
								{w.label}
							</Link>
						)
						if (i !== 2) return [link]
						return [
							<button
								key="log"
								type="button"
								onClick={() => openLog()}
								aria-label="+ Log"
								className="mx-auto -mt-6 grid size-14 place-items-center rounded-full bg-red text-3xl leading-none shadow-lg active:scale-95"
							>
								+
							</button>,
							link,
						]
					})}
				</nav>

				<LogDialog type={logType} onClose={() => setLogType(null)} />
			</div>
		</OpenLog>
	)
}
