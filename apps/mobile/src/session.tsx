import { useQueryClient } from '@tanstack/react-query'
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { api, setSession, tokenStore } from './api'

type Session = { ready: boolean; signedIn: boolean; signIn(token: string): Promise<void>; signOut(): Promise<void> }

const Ctx = createContext<Session | null>(null)

export function SessionProvider({ children }: { children: ReactNode }) {
	const queryClient = useQueryClient()
	const [state, setState] = useState({ ready: false, signedIn: false })

	const clear = useCallback(async () => {
		setSession(null)
		await tokenStore.clear()
		queryClient.clear()
		setState({ ready: true, signedIn: false })
	}, [queryClient])

	useEffect(() => {
		tokenStore.get().then((t) => {
			setSession(t, clear)
			setState({ ready: true, signedIn: Boolean(t) })
		})
	}, [clear])

	const signIn = useCallback(async (t: string) => {
		await tokenStore.set(t)
		setSession(t, clear)
		setState({ ready: true, signedIn: true })
	}, [clear])

	const signOut = useCallback(async () => {
		await api.logout().catch(() => {})
		await clear()
	}, [clear])

	return <Ctx.Provider value={{ ...state, signIn, signOut }}>{children}</Ctx.Provider>
}

export function useSession() {
	const s = useContext(Ctx)
	if (!s) throw new Error('useSession outside SessionProvider')
	return s
}
