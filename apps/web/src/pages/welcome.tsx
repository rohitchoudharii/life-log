import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { errorMessage, orpc } from '../rpc'
import { AuthCard, Button, ErrorText, Field } from '../ui'

// The invite token is in the URL fragment, which browsers never send to a server.
// Read it once, then remove it from the address bar and history.
const token = window.location.pathname === '/welcome' ? window.location.hash.slice(1) : ''
if (token) window.history.replaceState(null, '', window.location.pathname)

export function Welcome() {
	const navigate = useNavigate()
	const queryClient = useQueryClient()
	const [name, setName] = useState('')
	const [password, setPassword] = useState('')
	const [confirm, setConfirm] = useState('')
	const [mismatch, setMismatch] = useState(false)
	const accept = useMutation(
		orpc.auth.acceptInvite.mutationOptions({
			onSuccess: async () => {
				await queryClient.invalidateQueries()
				await navigate({ to: '/' })
			},
		}),
	)
	if (!token)
		return (
			<AuthCard title="This link is incomplete">
				<p className="text-sm">Open the whole invite link you were sent, or ask for a new one.</p>
			</AuthCard>
		)
	return (
		<AuthCard title="Welcome to the club">
			<form
				className="grid gap-4"
				onSubmit={(e) => {
					e.preventDefault()
					setMismatch(password !== confirm)
					if (password === confirm) accept.mutate({ token, name, password })
				}}
			>
				<Field label="Your name" autoComplete="name" required value={name} onChange={(e) => setName(e.target.value)} />
				<Field
					label="Choose a password"
					type="password"
					autoComplete="new-password"
					minLength={10}
					required
					value={password}
					onChange={(e) => setPassword(e.target.value)}
				/>
				<Field
					label="Type it again"
					type="password"
					autoComplete="new-password"
					required
					value={confirm}
					onChange={(e) => setConfirm(e.target.value)}
				/>
				<p className="-mt-2 text-xs text-ink/60">At least 10 characters. A short sentence is easy to remember.</p>
				<ErrorText>
					{mismatch ? 'The two passwords are different.' : accept.isError && errorMessage(accept.error)}
				</ErrorText>
				<Button type="submit" disabled={accept.isPending}>
					{accept.isPending ? 'Setting up…' : 'Set password and enter'}
				</Button>
			</form>
		</AuthCard>
	)
}
