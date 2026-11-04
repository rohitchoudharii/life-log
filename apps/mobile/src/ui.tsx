import Ionicons from '@expo/vector-icons/Ionicons'
import type { ReactNode } from 'react'
import {
	ActivityIndicator,
	Platform,
	Pressable,
	ScrollView,
	Text as RNText,
	TextInput,
	View,
	type StyleProp,
	type TextInputProps,
	type TextStyle,
	type ViewStyle,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { font, hairline, radius, space, useColors } from './theme'

type TextVariant = 'title' | 'heading' | 'question' | 'body' | 'muted' | 'label'

const textStyles: Record<TextVariant, TextStyle> = {
	title: { fontFamily: font.semibold, fontSize: 26, lineHeight: 32, letterSpacing: -0.4 },
	heading: { fontFamily: font.semibold, fontSize: 19, lineHeight: 26, letterSpacing: -0.2 },
	question: { fontFamily: font.semibold, fontSize: 20, lineHeight: 28, letterSpacing: -0.2 },
	body: { fontFamily: font.regular, fontSize: 15, lineHeight: 23 },
	muted: { fontFamily: font.regular, fontSize: 13, lineHeight: 18 },
	label: { fontFamily: font.medium, fontSize: 12, lineHeight: 16 },
}

export function Text({
	variant = 'body',
	style,
	children,
	selectable,
	numberOfLines,
}: {
	variant?: TextVariant
	style?: StyleProp<TextStyle>
	children: ReactNode
	selectable?: boolean
	numberOfLines?: number
}) {
	const c = useColors()
	const color = variant === 'muted' || variant === 'label' ? c.sub : c.fg
	return (
		<RNText selectable={selectable} numberOfLines={numberOfLines} style={[textStyles[variant], { color }, style]}>
			{children}
		</RNText>
	)
}

/** A scrolling page with the theme's screen margins and the safe area applied. */
export function Screen({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
	const c = useColors()
	const insets = useSafeAreaInsets()
	const web = Platform.OS === 'web'
	return (
		<View style={{ flex: 1, backgroundColor: c.bg }}>
			<ScrollView
				contentContainerStyle={{
					paddingTop: (web ? 0 : insets.top) + space.screenTop,
					paddingHorizontal: space.screenX,
					paddingBottom: space.xl,
					gap: space.xl,
					width: '100%',
					maxWidth: 640,
					alignSelf: 'center',
					flexGrow: 1,
				}}
				keyboardShouldPersistTaps="handled"
				automaticallyAdjustKeyboardInsets
			>
				{children}
			</ScrollView>
			{footer ? (
				<View
					style={{
						paddingHorizontal: space.screenX,
						paddingTop: space.md,
						paddingBottom: space.lg,
						borderTopWidth: hairline,
						borderColor: c.ring,
						width: '100%',
						maxWidth: 640,
						alignSelf: 'center',
					}}
				>
					{footer}
				</View>
			) : null}
		</View>
	)
}

export function Group({ children, gap = space.sm, style }: { children: ReactNode; gap?: number; style?: StyleProp<ViewStyle> }) {
	return <View style={[{ gap }, style]}>{children}</View>
}

export function Row({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
	return <View style={[{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.sm }, style]}>{children}</View>
}

export function Tile({ children, onPress, style }: { children: ReactNode; onPress?: () => void; style?: StyleProp<ViewStyle> }) {
	const c = useColors()
	const base: ViewStyle = {
		backgroundColor: c.tile,
		borderRadius: radius,
		borderWidth: hairline,
		borderColor: c.ring,
		paddingVertical: 14,
		paddingHorizontal: space.lg,
		gap: space.xs,
	}
	if (!onPress) return <View style={[base, style]}>{children}</View>
	return (
		<Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [base, pressed && { borderColor: c.fg }, style]}>
			{children}
		</Pressable>
	)
}

export function Button({
	title,
	onPress,
	kind = 'primary',
	disabled,
	loading,
	style,
}: {
	title: string
	onPress: () => void
	kind?: 'primary' | 'outline'
	disabled?: boolean
	loading?: boolean
	style?: StyleProp<ViewStyle>
}) {
	const c = useColors()
	const primary = kind === 'primary'
	const inactive = disabled || loading
	return (
		<Pressable
			accessibilityRole="button"
			accessibilityState={{ disabled: inactive }}
			disabled={inactive}
			onPress={onPress}
			style={({ pressed }) => [
				{
					minHeight: 48,
					borderRadius: radius,
					paddingHorizontal: space.lg,
					alignItems: 'center',
					justifyContent: 'center',
					backgroundColor: primary ? c.fg : c.bg,
					borderWidth: hairline,
					borderColor: primary ? c.fg : c.ring,
					opacity: inactive ? 0.4 : 1,
					transform: [{ scale: pressed ? 0.98 : 1 }],
				},
				style,
			]}
		>
			{loading ? (
				<ActivityIndicator color={primary ? c.bg : c.fg} />
			) : (
				<RNText style={{ fontFamily: font.semibold, fontSize: 15, color: primary ? c.bg : c.fg }}>{title}</RNText>
			)}
		</Pressable>
	)
}

export function Field(props: TextInputProps & { label: string }) {
	const c = useColors()
	const { label, style, ...rest } = props
	return (
		<Group gap={space.xs}>
			<Text variant="label">{label}</Text>
			<TextInput
				placeholderTextColor={c.sub}
				{...rest}
				style={[
					{
						fontFamily: font.regular,
						fontSize: 15,
						color: c.fg,
						borderWidth: hairline,
						borderColor: c.ring,
						outlineColor: c.fg,
						borderRadius: radius,
						paddingHorizontal: space.md,
						paddingVertical: space.md,
						minHeight: 48,
					},
					style,
				]}
			/>
		</Group>
	)
}

export function Pill({ children, filled }: { children: ReactNode; filled?: boolean }) {
	const c = useColors()
	return (
		<View
			style={{
				alignSelf: 'flex-start',
				borderRadius: radius,
				paddingHorizontal: space.sm,
				paddingVertical: 2,
				borderWidth: hairline,
				borderColor: c.fg,
				backgroundColor: filled ? c.fg : 'transparent',
			}}
		>
			<RNText style={{ fontFamily: font.medium, fontSize: 11, lineHeight: 16, color: filled ? c.bg : c.fg }}>{children}</RNText>
		</View>
	)
}

export function Progress({ value }: { value: number }) {
	const c = useColors()
	return (
		<View style={{ height: 6, borderRadius: 3, backgroundColor: c.track, overflow: 'hidden' }}>
			<View style={{ height: '100%', width: `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%`, backgroundColor: c.fg }} />
		</View>
	)
}

export function ErrorText({ error }: { error: unknown }) {
	if (!error) return null
	return <Text variant="muted">{error instanceof Error ? error.message : String(error)}</Text>
}

export function Loading() {
	const c = useColors()
	return (
		<View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: c.bg }}>
			<ActivityIndicator color={c.fg} />
		</View>
	)
}

/** One option in a row of choices, such as session length or question intensity. */
export function Choice({ label, detail, selected, onPress }: { label: string; detail?: string; selected: boolean; onPress(): void }) {
	const c = useColors()
	return (
		<Pressable
			accessibilityRole="radio"
			accessibilityState={{ selected }}
			onPress={onPress}
			style={({ pressed }) => ({
				flex: 1,
				minHeight: 40,
				paddingVertical: space.sm,
				paddingHorizontal: space.sm,
				gap: 2,
				alignItems: 'center',
				justifyContent: 'center',
				borderRadius: radius,
				borderWidth: selected ? 2 : hairline,
				borderColor: selected || pressed ? c.fg : c.ring,
			})}
		>
			<Text style={{ fontFamily: font.medium, fontSize: 13 }}>{label}</Text>
			{detail ? (
				<Text variant="muted" style={{ fontSize: 11, lineHeight: 14, textAlign: 'center' }}>
					{detail}
				</Text>
			) : null}
		</Pressable>
	)
}

export function ChoiceRow({ children }: { children: ReactNode }) {
	return <View style={{ flexDirection: 'row', gap: space.sm }}>{children}</View>
}

/** A checkbox; `mixed` is for a parent where only some children are ticked. */
export function Checkbox({ state }: { state: boolean | 'mixed' }) {
	const c = useColors()
	return (
		<View
			style={{
				width: 20,
				height: 20,
				borderRadius: 4,
				borderWidth: state ? 0 : 1.5,
				borderColor: c.sub,
				backgroundColor: state ? c.fg : 'transparent',
				alignItems: 'center',
				justifyContent: 'center',
			}}
		>
			{state ? <Ionicons name={state === 'mixed' ? 'remove' : 'checkmark'} size={15} color={c.bg} /> : null}
		</View>
	)
}
