import Ionicons from '@expo/vector-icons/Ionicons'
import { Tabs } from 'expo-router'
import type { ComponentProps } from 'react'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { font, hairline, useColors } from '@/theme'

type IconName = ComponentProps<typeof Ionicons>['name']

export default function TabsLayout() {
	const c = useColors()
	const insets = useSafeAreaInsets()
	const icon = (name: IconName, active: IconName) =>
		function TabIcon({ focused, size }: { focused: boolean; size: number }) {
			return <Ionicons name={focused ? active : name} size={size - 2} color={focused ? c.fg : c.sub} />
		}
	return (
		<Tabs
			screenOptions={{
				headerShown: false,
				tabBarActiveTintColor: c.fg,
				tabBarInactiveTintColor: c.sub,
				tabBarLabelStyle: { fontFamily: font.medium, fontSize: 11, lineHeight: 14, flexShrink: 0 },
				tabBarStyle: {
					backgroundColor: c.bg,
					borderTopColor: c.ring,
					borderTopWidth: hairline,
					height: 64 + insets.bottom,
					paddingTop: 4,
					paddingBottom: insets.bottom + 4,
				},
				sceneStyle: { backgroundColor: c.bg },
			}}
		>
			<Tabs.Screen name="index" options={{ title: 'Today', tabBarIcon: icon('today-outline', 'today') }} />
			<Tabs.Screen name="library" options={{ title: 'Library', tabBarIcon: icon('book-outline', 'book') }} />
			<Tabs.Screen name="review" options={{ title: 'Review', tabBarIcon: icon('albums-outline', 'albums') }} />
			<Tabs.Screen name="settings" options={{ title: 'Settings', tabBarIcon: icon('settings-outline', 'settings') }} />
		</Tabs>
	)
}
