import { useState } from 'react'
import { api } from '@/api'
import { useSession } from '@/session'
import { space } from '@/theme'
import { Button, ErrorText, Field, Group, Screen, Text } from '@/ui'

export default function SignIn() {
	const { signIn } = useSession()
	const [email, setEmail] = useState('')
	const [code, setCode] = useState('')
	const [step, setStep] = useState<'email' | 'code'>('email')
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<unknown>(null)

	const run = async (fn: () => Promise<void>) => {
		setBusy(true)
		setError(null)
		try {
			await fn()
		} catch (e) {
			setError(e)
		} finally {
			setBusy(false)
		}
	}

	const sendCode = () =>
		run(async () => {
			await api.requestCode(email)
			setStep('code')
		})
	const verify = () =>
		run(async () => {
			const { token } = await api.verifyCode(email, code)
			await signIn(token)
		})

	return (
		<Screen>
			<Group style={{ marginTop: space.xl }}>
				<Text variant="title">Peak</Text>
				<Text variant="muted">Read, recall, repeat. Practice that sticks.</Text>
			</Group>
			{step === 'email' ? (
				<Group gap={space.lg}>
					<Field
						label="Email"
						value={email}
						onChangeText={setEmail}
						placeholder="you@example.com"
						autoCapitalize="none"
						autoComplete="email"
						keyboardType="email-address"
						inputMode="email"
						onSubmitEditing={sendCode}
						returnKeyType="send"
					/>
					<Button title="Email me a code" onPress={sendCode} loading={busy} disabled={!email.includes('@')} />
					<ErrorText error={error} />
				</Group>
			) : (
				<Group gap={space.lg}>
					<Text>We sent a 6-digit code to {email}. It expires in 10 minutes.</Text>
					<Field
						label="Code"
						value={code}
						onChangeText={(v) => setCode(v.replace(/\D/g, '').slice(0, 6))}
						placeholder="123456"
						keyboardType="number-pad"
						inputMode="numeric"
						autoComplete="one-time-code"
						textContentType="oneTimeCode"
						onSubmitEditing={verify}
						autoFocus
					/>
					<Button title="Sign in" onPress={verify} loading={busy} disabled={code.length !== 6} />
					<Button
						title="Use a different email"
						kind="outline"
						onPress={() => {
							setStep('email')
							setCode('')
							setError(null)
						}}
					/>
					<ErrorText error={error} />
				</Group>
			)}
		</Screen>
	)
}
