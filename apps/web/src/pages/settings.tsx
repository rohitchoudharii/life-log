import type { AiKey } from '@life-log-club/contract'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { errorMessage, orpc } from '../rpc'
import { useSignOut } from '../shell'
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
	const signOut = useSignOut()

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
			<AiUsage />
			<ReviewTarget />
			<div className="flex flex-wrap items-center gap-3 rounded-2xl bg-white p-5 ring-1 ring-ink/5">
				<div className="mr-auto">
					<h2 className="text-lg font-semibold">Account</h2>
					<p className="text-sm text-ink/60">See where you are signed in, and sign out a lost device.</p>
				</div>
				<Link to="/devices" className="rounded-lg border border-ink/15 px-3 py-1.5 text-sm hover:bg-ink/5">
					Signed-in devices
				</Link>
				<button type="button" onClick={() => signOut.mutate({})} className="rounded-lg border border-ink/15 px-3 py-1.5 text-sm hover:bg-red/10 hover:text-red">
					Sign out
				</button>
			</div>
		</section>
	)
}

const TARGETS = [0.8, 0.85, 0.9, 0.95]

/** The chance of recall to aim for when an idea comes back. One click saves it. */
function ReviewTarget() {
	const queryClient = useQueryClient()
	const prefs = useQuery(orpc.preferences.get.queryOptions())
	const save = useMutation(
		orpc.preferences.update.mutationOptions({
			onSuccess: (saved) => queryClient.setQueryData(orpc.preferences.get.queryKey(), saved),
		}),
	)
	const current = save.isPending ? save.variables.desiredRetention : prefs.data?.desiredRetention
	return (
		<div className="grid gap-3 rounded-2xl bg-white p-5 ring-1 ring-ink/5">
			<h2 className="text-lg font-semibold">Review</h2>
			<fieldset className="grid gap-2" disabled={!prefs.data}>
				<legend className="mb-1.5 text-sm font-medium text-ink/80">When an idea comes back, aim to remember it</legend>
				<div className="flex flex-wrap gap-2">
					{TARGETS.map((t) => (
						<label
							key={t}
							className="cursor-pointer rounded-lg border border-ink/15 px-3 py-1.5 text-sm has-[:checked]:border-navy has-[:checked]:bg-navy has-[:checked]:text-white has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-navy/40"
						>
							<input
								type="radio"
								name="review-target"
								className="sr-only"
								checked={current !== undefined && Math.abs(current - t) < 0.001}
								onChange={() => save.mutate({ desiredRetention: t })}
							/>
							{Math.round(t * 100)}%
						</label>
					))}
				</div>
				<p className="text-sm text-ink/60">Higher means more reviews.</p>
			</fieldset>
			<ErrorText>{save.error && errorMessage(save.error)}</ErrorText>
		</div>
	)
}

const dollars = (n: number) => `$${n.toFixed(2).replace(/\.00$/, '')}`

/** The usage line, "This month: 46 calls · about $0.31 of $5", and the monthly budget. */
function usageLine(u: { calls: number; tokens: number; costUsd: number | null; budgetUsd: number }) {
	const calls = `${u.calls} ${u.calls === 1 ? 'call' : 'calls'}`
	const spend = u.costUsd === null ? `${u.tokens.toLocaleString('en')} tokens` : `about ${dollars(u.costUsd)} of ${dollars(u.budgetUsd)}`
	return `This month: ${calls} · ${spend}`
}

function AiUsage() {
	const queryClient = useQueryClient()
	const usage = useQuery(orpc.ai.usage.queryOptions())
	const [budget, setBudget] = useState('')
	const save = useMutation(
		orpc.preferences.update.mutationOptions({
			onSuccess: async () => {
				setBudget('')
				await Promise.all([queryClient.invalidateQueries({ queryKey: orpc.ai.key() }), queryClient.invalidateQueries({ queryKey: orpc.preferences.key() })])
			},
		}),
	)
	const u = usage.data
	return (
		<div className="grid gap-4 rounded-2xl bg-white p-5 ring-1 ring-ink/5">
			<div>
				<h2 className="text-lg font-semibold">AI usage</h2>
				<p className="text-sm text-ink/60" data-testid="ai-usage">
					{u ? usageLine(u) : '…'}
				</p>
				{u?.reached && <p className="mt-1 text-sm text-red">This month’s budget is used, so questions are not written in the background.</p>}
			</div>
			<form
				className="flex flex-wrap items-end gap-3"
				onSubmit={(e) => {
					e.preventDefault()
					save.mutate({ aiMonthlyBudgetUsd: Number(budget) })
				}}
			>
				<Field
					label="Monthly budget in US dollars"
					type="number"
					min={0}
					step="0.5"
					inputMode="decimal"
					required
					placeholder={u ? String(u.budgetUsd) : ''}
					value={budget}
					onChange={(e) => setBudget(e.target.value)}
				/>
				<Button type="submit" disabled={save.isPending}>
					{save.isPending ? 'Saving…' : 'Save budget'}
				</Button>
			</form>
			<ErrorText>{save.error && errorMessage(save.error)}</ErrorText>
		</div>
	)
}
