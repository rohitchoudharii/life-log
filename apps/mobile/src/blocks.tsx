import type { Block, Link } from '@life-log-club/core'
import type { ReactNode } from 'react'
import { Image, Platform, ScrollView, Text as RNText, View } from 'react-native'
import { BASE } from './api'
import { hairline, radius, space, useColors } from './theme'
import { Group, Text } from './ui'

export const mono = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'ui-monospace, Menlo, monospace' })

/** Text with its links underlined; tapping one calls `onLink` with its address. */
function Linked({ text, links, onLink }: { text: string; links: readonly Link[]; onLink?(href: string): void }) {
	if (!onLink || !links.length) return text
	const out: ReactNode[] = []
	let at = 0
	for (const [i, l] of [...links].sort((a, b) => a.start - b.start).entries()) {
		if (l.start < at) continue
		out.push(text.slice(at, l.start))
		out.push(
			<RNText key={i} accessibilityRole="link" onPress={() => onLink(l.href)} style={{ textDecorationLine: 'underline' }}>
				{text.slice(l.start, l.end)}
			</RNText>,
		)
		at = l.end
	}
	out.push(text.slice(at))
	return out
}

/**
 * Renders stored content blocks natively. No foreign HTML is ever rendered. With `onLink`, links
 * in the text are underlined and tappable.
 */
export function BlockView({ block, selectable = true, onLink }: { block: Block; selectable?: boolean; onLink?(href: string): void }) {
	const c = useColors()
	switch (block.type) {
		case 'heading':
			return <Text variant="heading" selectable={selectable}>{block.text}</Text>
		case 'paragraph':
			return (
				<Text selectable={selectable} style={{ fontSize: 16, lineHeight: 26 }}>
					<Linked text={block.text} links={block.links ?? []} onLink={onLink} />
				</Text>
			)
		case 'quote':
			return (
				<View style={{ paddingLeft: space.md, borderLeftWidth: 2, borderColor: c.ring }}>
					<Text selectable={selectable} style={{ fontSize: 16, lineHeight: 26, color: c.sub }}>
						<Linked text={block.text} links={block.links ?? []} onLink={onLink} />
					</Text>
				</View>
			)
		case 'list':
			return (
				<Group gap={space.xs}>
					{block.items.map((item, i) => (
						<View key={i} style={{ flexDirection: 'row', gap: space.sm }}>
							<Text style={{ fontSize: 16, lineHeight: 26, minWidth: 18 }}>{block.ordered ? `${i + 1}.` : '•'}</Text>
							<Text selectable={selectable} style={{ flex: 1, fontSize: 16, lineHeight: 26 }}>
								<Linked text={item} links={(block.links ?? []).filter((l) => l.item === i)} onLink={onLink} />
							</Text>
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
			return <CodeBlock code={block.text} selectable={selectable} />
	}
}

/**
 * Code in monospace. In the reader it scrolls sideways so long lines keep their shape; in a
 * question it wraps (`wrap`), so no line is hidden from someone who must read all of it.
 */
export function CodeBlock({ code, wrap = false, selectable = true }: { code: string; wrap?: boolean; selectable?: boolean }) {
	const c = useColors()
	const text = (
		<RNText selectable={selectable} style={{ fontFamily: mono, fontSize: 13, lineHeight: 20, color: c.fg }}>
			{code}
		</RNText>
	)
	const frame = { borderRadius: radius, borderWidth: hairline, borderColor: c.ring }
	if (wrap) return <View style={[frame, { padding: space.md }]}>{text}</View>
	return (
		<ScrollView horizontal style={frame} contentContainerStyle={{ padding: space.md }}>
			{text}
		</ScrollView>
	)
}
