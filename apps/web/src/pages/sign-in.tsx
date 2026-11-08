import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { errorMessage, orpc } from '../rpc'
import { AuthCard, Button, ErrorText, Field } from '../ui'

export function SignIn({ reason }: { reason?: 'expired' | 'signed-out' | null }) {
	const queryClient = useQueryClient()
	const [email, setEmail] = useState('')
	const [password, setPassword] = useState('')
	const signIn = useMutation(
		orpc.auth.signIn.mutationOptions({
			// The signed-in layout re-renders from the fresh `me` query, on whatever page this was.
			onSuccess: () => queryClient.invalidateQueries(),
		}),
	)
	return (
		<AuthCard title="Sign in">
			<form
				className="grid gap-4"
				onSubmit={(e) => {
					e.preventDefault()
					signIn.mutate({ email, password })
				}}
			>
				{reason === 'expired' && (
					<p className="rounded-lg bg-cream px-3 py-2 text-sm">
						You have been away from this device for 30 days, so sign in again.
					</p>
				)}
				<Field
					label="Email"
					type="email"
					autoComplete="email"
					required
					value={email}
					onChange={(e) => setEmail(e.target.value)}
				/>
				<Field
					label="Password"
					type="password"
					autoComplete="current-password"
					required
					value={password}
					onChange={(e) => setPassword(e.target.value)}
				/>
				<ErrorText>{signIn.isError && errorMessage(signIn.error)}</ErrorText>
				<Button type="submit" disabled={signIn.isPending}>
					{signIn.isPending ? 'Signing in…' : 'Sign in'}
				</Button>
				<p className="text-xs text-ink/60">Life Log Club is invite only. Forgot your password? Ask for a new invite link.</p>
			</form>
		</AuthCard>
	)
}
