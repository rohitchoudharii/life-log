import type { AiKey, Preferences } from '@life-log-club/contract'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { GuessFirstSwitch } from '../answer'
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
			<QuestionSettings />
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

/** One click on an option saves it. */
function Choice<T extends string>({
	legend,
	name,
	options,
	value,
	onPick,
}: { legend: string; name: string; options: { value: T; label: string; hint: string }[]; value: T | undefined; onPick: (v: T) => void }) {
	const picked = options.find((o) => o.value === value)
	return (
		<fieldset className="grid gap-2">
			<legend className="mb-1.5 text-sm font-medium text-ink/80">{legend}</legend>
			<div className="flex flex-wrap gap-2">
				{options.map((o) => (
					<label
						key={o.value}
						className="cursor-pointer rounded-lg border border-ink/15 px-3 py-1.5 text-sm has-[:checked]:border-navy has-[:checked]:bg-navy has-[:checked]:text-white has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-navy/40"
					>
						<input type="radio" name={name} className="sr-only" checked={value === o.value} onChange={() => onPick(o.value)} />
						{o.label}
					</label>
				))}
			</div>
			{picked && <p className="text-sm text-ink/60">{picked.hint}</p>}
		</fieldset>
	)
}

const AMOUNTS = [
	{ value: 'quick', label: 'Quick', hint: 'No written questions: each key idea comes back through its cue.' },
	{ value: 'standard', label: 'Standard', hint: 'One question on each key idea, besides its cue. Best for most reading.' },
	{ value: 'thorough', label: 'Thorough', hint: 'Two questions on each key idea: one on why, one applying it.' },
] as const
const KINDS = [
	{ value: 'mixed', label: 'Mixed', hint: 'Mostly written answers, with multiple choice where the wrong options are tempting.' },
	{ value: 'written', label: 'Written', hint: 'Written answers only. Harder, and the best for remembering.' },
	{ value: 'choice', label: 'Choice', hint: 'Multiple choice only. Quicker, but recognising is easier than recalling.' },
] as const

/** How questions are written for newly read sections, and Guess first. Each choice saves at once. */
function QuestionSettings() {
	const queryClient = useQueryClient()
	const prefs = useQuery(orpc.preferences.get.queryOptions())
	// Each choice shows at once, without waiting for the save; a failed save shows the saved values again.
	const [draft, setDraft] = useState<Partial<Preferences>>({})
	const save = useMutation(
		orpc.preferences.update.mutationOptions({
			onError: () => setDraft({}),
			onSuccess: (saved) => queryClient.setQueryData(orpc.preferences.get.queryKey(), saved),
		}),
	)
	const change = (c: Partial<Preferences>) => {
		setDraft((d) => ({ ...d, ...c }))
		save.mutate(c)
	}
	const p = prefs.data && { ...prefs.data, ...draft }
	return (
		<div className="grid gap-4 rounded-2xl bg-white p-5 ring-1 ring-ink/5">
			<div>
				<h2 className="text-lg font-semibold">Questions</h2>
				<p className="text-sm text-ink/60">For sections you read from now on. To change a section you read already, use Rewrite questions in its menu.</p>
			</div>
			<div className="grid gap-4" aria-disabled={!p}>
				<Choice legend="How many" name="question-amount" options={[...AMOUNTS]} value={p?.questionAmount} onPick={(questionAmount) => change({ questionAmount })} />
				<Choice legend="Kinds" name="question-style" options={[...KINDS]} value={p?.questionStyle} onPick={(questionStyle) => change({ questionStyle })} />
				<label className="flex items-start gap-2 text-sm">
					<input
						type="checkbox"
						className="mt-0.5 size-4 accent-navy"
						checked={p?.qualityCheck ?? true}
						disabled={!p}
						onChange={(e) => change({ qualityCheck: e.target.checked })}
					/>
					<span>
						<span className="font-medium">Check questions twice</span>
						<span className="block text-ink/60">A second AI call checks each question and its answer before you see it. Fewer wrong questions, a little more use of your key.</span>
					</span>
				</label>
				<GuessFirstSwitch />
			</div>
			<ErrorText>{save.error && errorMessage(save.error)}</ErrorText>
		</div>
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
			<Tuning />
			<ErrorText>{save.error && errorMessage(save.error)}</ErrorText>
		</div>
	)
}

const day = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })

/** One quiet line on tuning the schedule to the member's memory: how far off it is, or how it went. */
function Tuning() {
	const tuning = useQuery(orpc.preferences.tuning.queryOptions())
	const t = tuning.data
	if (!t) return null
	let line: string
	if (t.tuned && t.last?.kept) line = `Tuned to your own memory on ${day.format(t.last.at)}: it predicts your recall ${Math.max(1, Math.round(t.last.improvement * 100))}% better than before.`
	else if (t.tuned) line = `Tuned to your own memory. The last check, on ${day.format(t.last!.at)}, found nothing better, so it stays as it is.`
	else if (t.last) line = `Checked on ${day.format(t.last.at)}: the standard settings still fit your reviews best. It checks again each month.`
	else if (t.reviews >= t.needed) line = 'You have enough answers: the schedule tunes itself to your memory at the start of next month.'
	else line = `After ${t.needed.toLocaleString('en-GB')} answers (you have ${t.reviews.toLocaleString('en-GB')}), the schedule tunes itself to your memory each month.`
	return (
		<p className="text-sm text-ink/60" data-testid="tuning">
			{line}
		</p>
	)
}

const dollars = (n: number) => `$${n.toFixed(2).replace(/\.00$/, '')}`

/** The usage line, "This month: 46 calls · about $0.31 of $5", and the monthly budget. */
function usageLine(u: { calls: number; tokens: number; costUsd: number | null; budgetUsd: number }) {
	const calls = `${u.calls} ${u.calls === 1 ? 'call' : 'calls'}`
	const spend = u.costUsd === null ? `${u.tokens.toLocaleString('en')} tokens` : `about ${dollars(u.costUsd)} of ${dollars(u.budgetUsd)}`
	return `This month: ${calls} · ${spend}`
}

const monthName = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })

/** Calls and tokens in each earlier month, so the member sees how their use changes over time. */
function UsageHistory() {
	const history = useQuery(orpc.ai.usageHistory.queryOptions())
	const now = new Date()
	const earlier = (history.data ?? []).filter((m) => m.month.getUTCFullYear() !== now.getUTCFullYear() || m.month.getUTCMonth() !== now.getUTCMonth())
	if (!earlier.length) return null
	return (
		<details className="text-sm">
			<summary className="cursor-pointer text-ink/60">Earlier months</summary>
			<table className="mt-2 w-full" data-testid="usage-history">
				<thead className="sr-only">
					<tr>
						<th>Month</th>
						<th>Calls</th>
						<th>Tokens</th>
					</tr>
				</thead>
				<tbody>
					{earlier.map((m) => (
						<tr key={m.month.toISOString()} className="border-t border-ink/5">
							<td className="py-1.5">{monthName.format(m.month)}</td>
							<td className="py-1.5 text-right tabular-nums">
								{m.calls.toLocaleString('en')} {m.calls === 1 ? 'call' : 'calls'}
							</td>
							<td className="py-1.5 text-right tabular-nums">{m.tokens.toLocaleString('en')} tokens</td>
						</tr>
					))}
				</tbody>
			</table>
		</details>
	)
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
			<UsageHistory />
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
