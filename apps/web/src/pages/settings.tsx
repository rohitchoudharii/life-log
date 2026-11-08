import type { AiKey } from '@life-log-club/contract'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { errorMessage, orpc } from '../rpc'
import { Button, ErrorText, Field } from '../ui'

const PROVIDERS: { id: AiKey['provider']; name: string; hint: string }[] = [
	{ id: 'anthropic', name: 'Anthropic', hint: 'Starts with sk-ant-. Create one at console.anthropic.com.' },
	{ id: 'openai', name: 'OpenAI', hint: 'Starts with sk-. Create one at platform.openai.com.' },
]

export function Settings() {
	const queryClient = useQueryClient()
	const key = useQuery(orpc.ai.getKey.queryOptions())
	const [provider, setProvider] = useState<AiKey['provider']>('anthropic')
	const [apiKey, setApiKey] = useState('')
	const refresh = () => queryClient.invalidateQueries({ queryKey: orpc.ai.key() })
	const save = useMutation(
		orpc.ai.saveKey.mutationOptions({
			onSuccess: async () => {
				setApiKey('')
				await refresh()
			},
		}),
	)
	const remove = useMutation(orpc.ai.removeKey.mutationOptions({ onSuccess: refresh }))
	const current = key.data

	return (
		<section className="grid gap-4">
			<div>
				<h1 className="text-2xl font-semibold">Settings</h1>
			</div>
			<div className="grid gap-4 rounded-2xl bg-white p-5 ring-1 ring-ink/5">
				<div>
					<h2 className="text-lg font-semibold">Your AI key</h2>
					<p className="text-sm text-ink/60">
						Questions and recall checks use your own Anthropic or OpenAI key. It is stored encrypted and never shown
						again in full.
					</p>
				</div>
				{key.isPending ? null : current ? (
					<div className="flex flex-wrap items-center gap-3" data-testid="ai-key">
						<p className="mr-auto">
							<span className="font-medium">{PROVIDERS.find((p) => p.id === current.provider)?.name}</span>
							<span className="text-ink/60"> · {current.model} · key ending in {current.last4}</span>
						</p>
						<button
							type="button"
							className="rounded-lg border border-ink/15 px-3 py-1.5 text-sm hover:bg-red/10 hover:text-red"
							disabled={remove.isPending}
							onClick={() => remove.mutate({})}
						>
							Remove key
						</button>
					</div>
				) : (
					<form
						className="grid gap-4"
						onSubmit={(e) => {
							e.preventDefault()
							save.mutate({ provider, apiKey })
						}}
					>
						<fieldset className="flex gap-2">
							<legend className="mb-1.5 text-sm font-medium text-ink/80">Provider</legend>
							{PROVIDERS.map((p) => (
								<label
									key={p.id}
									className="cursor-pointer rounded-lg border border-ink/15 px-3 py-1.5 text-sm has-[:checked]:border-navy has-[:checked]:bg-navy has-[:checked]:text-white"
								>
									<input
										type="radio"
										name="provider"
										className="sr-only"
										checked={provider === p.id}
										onChange={() => setProvider(p.id)}
									/>
									{p.name}
								</label>
							))}
						</fieldset>
						<Field
							label="API key"
							type="password"
							autoComplete="off"
							required
							value={apiKey}
							onChange={(e) => setApiKey(e.target.value)}
						/>
						<p className="-mt-2 text-xs text-ink/60">{PROVIDERS.find((p) => p.id === provider)?.hint}</p>
						<ErrorText>{save.isError && errorMessage(save.error)}</ErrorText>
						<Button type="submit" disabled={save.isPending} className="justify-self-start">
							{save.isPending ? 'Checking the key…' : 'Check and save'}
						</Button>
					</form>
				)}
			</div>
		</section>
	)
}
