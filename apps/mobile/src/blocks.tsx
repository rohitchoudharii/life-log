import type { Block } from '@peak/core'
import { Image, Platform, ScrollView, Text as RNText, View } from 'react-native'
import { BASE } from './api'
import { hairline, radius, space, useColors } from './theme'
import { Group, Text } from './ui'

const mono = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'ui-monospace, Menlo, monospace' })

/** Renders stored content blocks natively. No foreign HTML is ever rendered. */
export function BlockView({ block }: { block: Block }) {
	const c = useColors()
	switch (block.type) {
		case 'heading':
			return <Text variant="heading" selectable>{block.text}</Text>
		case 'paragraph':
			return <Text selectable style={{ fontSize: 16, lineHeight: 26 }}>{block.text}</Text>
		case 'quote':
			return (
				<View style={{ paddingLeft: space.md, borderLeftWidth: 2, borderColor: c.ring }}>
					<Text selectable style={{ fontSize: 16, lineHeight: 26, color: c.sub }}>{block.text}</Text>
				</View>
			)
		case 'list':
			return (
				<Group gap={space.xs}>
					{block.items.map((item, i) => (
						<View key={i} style={{ flexDirection: 'row', gap: space.sm }}>
							<Text style={{ fontSize: 16, lineHeight: 26, minWidth: 18 }}>{block.ordered ? `${i + 1}.` : '•'}</Text>
							<Text selectable style={{ flex: 1, fontSize: 16, lineHeight: 26 }}>{item}</Text>
						</View>
					))}
				</Group>
			)
		case 'page':
			// Where a PDF page starts, so you can find the passage in the original.
			return (
				<Text variant="muted" style={{ fontSize: 12, textAlign: 'right' }}>
					Page {block.number}
				</Text>
			)
		case 'image':
			// Only our own copy is shown, from our server; the page's address is never loaded.
			if (!block.mediaId) return null
			return (
				<Image
					source={{ uri: `${BASE}/media/${block.mediaId}` }}
					accessibilityLabel={block.alt || 'Image from the page'}
					resizeMode="contain"
					style={{ width: '100%', aspectRatio: block.width && block.height ? block.width / block.height : 16 / 9, borderRadius: radius }}
				/>
			)
		case 'code':
			return (
				<ScrollView
					horizontal
					style={{ borderRadius: radius, borderWidth: hairline, borderColor: c.ring }}
					contentContainerStyle={{ padding: space.md }}
				>
					<RNText selectable style={{ fontFamily: mono, fontSize: 13, lineHeight: 20, color: c.fg }}>{block.text}</RNText>
				</ScrollView>
			)
	}
}
