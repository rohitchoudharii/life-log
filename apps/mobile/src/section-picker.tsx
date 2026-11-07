import Ionicons from '@expo/vector-icons/Ionicons'
import { subtreeEnd } from '@life-log-club/core'
import { useMemo, useState, type ReactNode } from 'react'
import { Pressable, View } from 'react-native'
import type { Section } from './api'
import { font, hairline, space, useColors } from './theme'
import { Checkbox, Group, Row, Text } from './ui'

/**
 * The section tree as a checklist, with each section's question count. Ticking a section ticks its
 * subsections; a parent shows a dash when only some of them are ticked. Sections `canPick` rejects
 * are greyed out and never ticked. `empty` is shown in place of a count of 0.
 */
export function SectionPicker({
	sections,
	selected,
	onChange,
	canPick = () => true,
	empty = '',
}: {
	sections: Section[]
	selected: Set<string>
	onChange(next: Set<string>): void
	canPick?: (s: Section) => boolean
	empty?: string
}) {
	const c = useColors()
	const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
	const levels = useMemo(() => sections.map((s) => s.level), [sections])
	const range = (i: number) => sections.slice(i, subtreeEnd(levels, i))
	const stateOf = (list: Section[]) => {
		const open = list.filter(canPick)
		const n = open.filter((s) => selected.has(s.id)).length
		return n === 0 ? false : n === open.length ? true : ('mixed' as const)
	}
	const toggle = (list: Section[]) => {
		const next = new Set(selected)
		const on = stateOf(list) !== true
		list.filter(canPick).forEach((s) => (on ? next.add(s.id) : next.delete(s.id)))
		onChange(next)
	}
	const questionsIn = (list: Section[]) => list.reduce((n, s) => n + s.questionCount, 0)

	const rows: ReactNode[] = []
	for (let i = 0; i < sections.length; i++) {
		const s = sections[i]!
		const subtree = range(i)
		const hasChildren = subtree.length > 1
		const isCollapsed = collapsed.has(s.id)
		const count = questionsIn(subtree)
		const off = !subtree.some(canPick)
		rows.push(
			<Row key={s.id} style={{ gap: 0, borderTopWidth: hairline, borderColor: c.ring }}>
				<Pressable
					accessibilityRole="checkbox"
					accessibilityState={{ checked: stateOf(subtree), disabled: off }}
					disabled={off}
					onPress={() => toggle(subtree)}
					style={({ pressed }) => ({
						flex: 1,
						flexDirection: 'row',
						alignItems: 'center',
						gap: space.md,
						minHeight: 48,
						paddingVertical: space.sm,
						paddingLeft: (s.level - 1) * 24,
						opacity: pressed ? 0.6 : 1,
					})}
				>
					{off ? <View style={{ width: 20, height: 20, borderRadius: 4, borderWidth: 1.5, borderColor: c.ring }} /> : <Checkbox state={stateOf(subtree)} />}
					<Text style={{ flex: 1, fontFamily: s.level === 1 ? font.medium : font.regular, color: off ? c.sub : c.fg }}>{s.title}</Text>
					<Text variant="muted" style={{ fontVariant: ['tabular-nums'] }}>
						{count || empty}
					</Text>
				</Pressable>
				<Pressable
					accessibilityRole="button"
					accessibilityLabel={isCollapsed ? `Show subsections of ${s.title}` : `Hide subsections of ${s.title}`}
					disabled={!hasChildren}
					onPress={() => {
						const next = new Set(collapsed)
						if (isCollapsed) next.delete(s.id)
						else next.add(s.id)
						setCollapsed(next)
					}}
					style={{ width: 40, height: 48, alignItems: 'center', justifyContent: 'center' }}
				>
					{hasChildren && <Ionicons name={isCollapsed ? 'chevron-down' : 'chevron-up'} size={16} color={c.sub} />}
				</Pressable>
			</Row>,
		)
		if (isCollapsed) i += subtree.length - 1
	}

	return (
		<Group gap={0}>
			<Row style={{ gap: 0 }}>
				<Pressable
					accessibilityRole="checkbox"
					accessibilityState={{ checked: stateOf(sections) }}
					onPress={() => toggle(sections)}
					style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 48 }}
				>
					<Checkbox state={stateOf(sections)} />
					<Text style={{ flex: 1, fontFamily: font.semibold }}>Select all</Text>
					<Text variant="muted" style={{ fontVariant: ['tabular-nums'] }}>
						{questionsIn(sections) || ''}
					</Text>
				</Pressable>
				<View style={{ width: 40 }} />
			</Row>
			{rows}
		</Group>
	)
}
