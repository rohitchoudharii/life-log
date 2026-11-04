import Ionicons from '@expo/vector-icons/Ionicons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'expo-router'
import { useState } from 'react'
import { Linking } from 'react-native'
import { api, type Provider } from '@/api'
import { space, useColors } from '@/theme'
import { Button, ErrorText, Field, Group, Loading, Row, Screen, Text, Tile } from '@/ui'

const guides: Record<Provider, { name: string; url: string; steps: string[] }> = {
	anthropic: {
		name: 'Anthropic',
		url: 'https://platform.claude.com/settings/keys',
		steps: [
			'Open the Claude Console at platform.claude.com and sign in, or create an account.',
			'Go to Settings, then Billing, and add a little credit. You pay Anthropic directly for what Peak uses.',
			'Go to Settings, then API keys, and choose Create key.',
			'Name it "Peak" and set Linked account to yourself. Scope it to one workspace, such as Default, not to all workspaces. Set the expiration to Never or a long period; Peak stops writing questions when the key expires.',
			'Copy the key. It starts with sk-ant- and is shown only once. Paste it in the box above.',
		],
	},
	openai: {
		name: 'OpenAI',
		url: 'https://platform.openai.com/api-keys',
		steps: [
			'Sign in at platform.openai.com. This is separate from ChatGPT, and a ChatGPT subscription does not pay for API use.',
			'Open Settings, then Billing, and add a little credit. Until the account has credit, the key will not work.',
			'Open API keys and choose Create new secret key. Name it "Peak", keep the Default project, and leave permissions on All.',
			'Copy the key. It starts with sk- and is shown only once. Paste it in the box above.',
		],
	},
}

export default function LlmKey() {
	const router = useRouter()
	const c = useColors()
	const queryClient = useQueryClient()
	const current = useQuery({ queryKey: ['key'], queryFn: api.key })
	const [replacing, setReplacing] = useState(false)
	const [provider, setProvider] = useState<Provider | null>(null)
	const [apiKey, setApiKey] = useState('')
	const [model, setModel] = useState<string | null>(null)
	const [showAll, setShowAll] = useState(false)

	const test = useMutation({
		mutationFn: () => api.testKey(provider!, apiKey.trim()),
		onSuccess: (r) => setModel(r.suggested),
	})
	const save = useMutation({
		mutationFn: () => api.saveKey(provider!, apiKey.trim(), model!),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ['key'] })
			queryClient.invalidateQueries({ queryKey: ['items'] })
			router.back()
		},
	})
	const remove = useMutation({
		mutationFn: api.deleteKey,
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['key'] }),
	})

	if (current.isPending) return <Loading />
	const existing = current.data?.key

	if (existing && !replacing)
		return (
			<Screen>
				<Group>
					<Text variant="title">{existing.provider === 'anthropic' ? 'Anthropic' : 'OpenAI'} is connected</Text>
					<Text variant="muted">
						Model {existing.model}, key ending {existing.last4}. The key is stored encrypted and never sent back to this device.
					</Text>
				</Group>
				<Group gap={space.sm}>
					<Button title="Use a different key or model" onPress={() => setReplacing(true)} />
					<Button title="Remove key" kind="outline" onPress={() => remove.mutate()} loading={remove.isPending} />
					<ErrorText error={remove.error} />
				</Group>
			</Screen>
		)

	const models = test.data?.models ?? []
	const shown = showAll ? models : models.slice(0, 6)
	const guide = provider && guides[provider]

	return (
		<Screen
			footer={
				test.data ? (
					<Button title="Save and connect" onPress={() => save.mutate()} loading={save.isPending} disabled={!model} />
				) : provider ? (
					<Button title="Check key" onPress={() => test.mutate()} loading={test.isPending} disabled={apiKey.trim().length < 10} />
				) : undefined
			}
		>
			<Group>
				<Text variant="title">Bring your own AI</Text>
				<Text variant="muted">
					Peak uses your own AI account to write questions and give feedback. Nobody else can use your key, and you can remove it any time.
				</Text>
			</Group>

			<Group gap={10}>
				<Text variant="label">1. Choose a provider</Text>
				<Row>
					{(Object.keys(guides) as Provider[]).map((p) => (
						<Tile
							key={p}
							onPress={() => {
								setProvider(p)
								test.reset()
								setModel(null)
							}}
							style={{ flex: 1, borderColor: provider === p ? c.fg : c.ring, borderWidth: provider === p ? 2 : 1 }}
						>
							<Text>{guides[p].name}</Text>
						</Tile>
					))}
				</Row>
				{!provider && <Text variant="muted">Choose one to see where to paste your key.</Text>}
			</Group>

			{guide && (
				<Group gap={10}>
					<Text variant="label">2. Paste your API key</Text>
					<Field
						label="API key"
						value={apiKey}
						onChangeText={(v) => {
							setApiKey(v)
							test.reset()
						}}
						placeholder={provider === 'anthropic' ? 'sk-ant-…' : 'sk-…'}
						autoCapitalize="none"
						autoCorrect={false}
						secureTextEntry
					/>
					<ErrorText error={test.error} />
				</Group>
			)}

			{test.data && (
				<Group gap={10}>
					<Text variant="label">3. Pick a model</Text>
					<Text variant="muted">The key works. We picked a fast, low-cost model; a larger one writes better questions but costs more.</Text>
					{shown.map((m) => (
						<Tile key={m} onPress={() => setModel(m)} style={{ borderColor: model === m ? c.fg : c.ring }}>
							<Row>
								<Text>{m}</Text>
								{model === m && <Ionicons name="checkmark" size={18} color={c.fg} />}
							</Row>
							{m === test.data.suggested && <Text variant="muted">Suggested</Text>}
						</Tile>
					))}
					{models.length > shown.length && <Button title={`Show all ${models.length} models`} kind="outline" onPress={() => setShowAll(true)} />}
					<ErrorText error={save.error} />
				</Group>
			)}
			{guide && (
				<Group gap={10}>
					<Text variant="label">No key yet? Create one</Text>
					<Tile style={{ gap: space.md }}>
						{guide.steps.map((s, i) => (
							<Row key={i} style={{ alignItems: 'flex-start', justifyContent: 'flex-start' }}>
								<Text variant="muted" style={{ minWidth: 16 }}>
									{i + 1}
								</Text>
								<Text style={{ flex: 1 }}>{s}</Text>
							</Row>
						))}
						<Button title={`Open ${guide.name} API keys page`} kind="outline" onPress={() => Linking.openURL(guide.url)} />
					</Tile>
				</Group>
			)}

		</Screen>
	)
}
