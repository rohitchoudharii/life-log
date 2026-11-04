import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Pressable, View } from 'react-native'
import { api } from './api'
import { hairline, radius, space, useColors } from './theme'
import { Button, ErrorText, Field, Group, Row, Text } from './ui'

function Chip({ label, selected, onPress }: { label: string; selected: boolean; onPress(): void }) {
	const c = useColors()
	return (
		<Pressable
			accessibilityRole="radio"
			accessibilityState={{ selected }}
			onPress={onPress}
			style={({ pressed }) => ({
				paddingVertical: space.sm,
				paddingHorizontal: space.md,
				borderRadius: radius,
				borderWidth: selected ? 2 : hairline,
				borderColor: selected || pressed ? c.fg : c.ring,
			})}
		>
			<Text>{label}</Text>
		</Pressable>
	)
}

/** Picks the bucket a reading goes into, or none; a new bucket can be made on the spot. */
export function BucketPicker({ value, onChange }: { value: string | null; onChange(id: string | null): void }) {
	const queryClient = useQueryClient()
	const items = useQuery({ queryKey: ['items'], queryFn: api.items })
	const [naming, setNaming] = useState(false)
	const [name, setName] = useState('')
	const create = useMutation({
		mutationFn: () => api.addCollection(name.trim()),
		onSuccess: ({ collection }) => {
			queryClient.invalidateQueries({ queryKey: ['items'] })
			onChange(collection.id)
			setNaming(false)
			setName('')
		},
	})
	const collections = items.data?.collections ?? []
	return (
		<Group gap={space.xs}>
			<Text variant="label">Bucket</Text>
			<View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
				<Chip label="None" selected={value === null} onPress={() => onChange(null)} />
				{collections.map((b) => (
					<Chip key={b.id} label={b.name} selected={value === b.id} onPress={() => onChange(b.id)} />
				))}
				{!naming && <Chip label="+ New bucket" selected={false} onPress={() => setNaming(true)} />}
			</View>
			{naming && (
				<Row style={{ alignItems: 'flex-end', gap: space.sm }}>
					<View style={{ flex: 1 }}>
						<Field label="New bucket" value={name} onChangeText={setName} placeholder="Website 1" autoFocus onSubmitEditing={() => name.trim() && create.mutate()} />
					</View>
					<Button title="Add" onPress={() => create.mutate()} disabled={!name.trim()} loading={create.isPending} />
				</Row>
			)}
			<ErrorText error={create.error} />
			<Text variant="muted">Keep pages from one site or one course together, in reading order.</Text>
		</Group>
	)
}
