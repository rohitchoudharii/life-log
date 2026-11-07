import { Manrope_400Regular, Manrope_500Medium, Manrope_600SemiBold, useFonts } from '@expo-google-fonts/manrope'
import Ionicons from '@expo/vector-icons/Ionicons'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Stack } from 'expo-router'
import * as SplashScreen from 'expo-splash-screen'
import { StatusBar } from 'expo-status-bar'
import { useEffect, useState } from 'react'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { SessionProvider, useSession } from '@/session'
import { font, loadAppearance, useColors, useScheme } from '@/theme'

SplashScreen.preventAutoHideAsync()

function Navigator() {
	const { ready, signedIn } = useSession()
	const c = useColors()
	useEffect(() => {
		if (ready) SplashScreen.hideAsync()
	}, [ready])
	if (!ready) return null
	return (
		<Stack
			screenOptions={{
				headerShadowVisible: false,
				headerStyle: { backgroundColor: c.bg },
				headerTintColor: c.fg,
				headerTitleStyle: { fontFamily: font.semibold, color: c.fg },
				headerBackTitleStyle: { fontFamily: font.regular },
				contentStyle: { backgroundColor: c.bg },
			}}
		>
			<Stack.Protected guard={signedIn}>
				<Stack.Screen name="(tabs)" options={{ headerShown: false }} />
				<Stack.Screen name="add" options={{ title: 'Add to library', presentation: 'modal' }} />
				<Stack.Screen name="read/[id]" options={{ headerTitle: () => null }} />
				<Stack.Screen name="test/[id]" options={{ title: 'Recall test' }} />
				<Stack.Screen name="manage/[id]" options={{ headerTitle: () => null }} />
				<Stack.Screen name="llm-key" options={{ headerTitle: () => null }} />
				<Stack.Screen name="teach/[id]" options={{ headerTitle: () => null }} />
				<Stack.Screen name="words" options={{ headerTitle: () => null }} />
			</Stack.Protected>
			<Stack.Protected guard={!signedIn}>
				<Stack.Screen name="sign-in" options={{ headerShown: false }} />
			</Stack.Protected>
		</Stack>
	)
}

export default function RootLayout() {
	const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 10_000 } } }))
	const scheme = useScheme()
	const [appearanceLoaded, setAppearanceLoaded] = useState(false)
	useEffect(() => {
		loadAppearance().finally(() => setAppearanceLoaded(true))
	}, [])
	const [fontsLoaded, fontError] = useFonts({ Manrope_400Regular, Manrope_500Medium, Manrope_600SemiBold, ...Ionicons.font })
	if ((!fontsLoaded && !fontError) || !appearanceLoaded) return null
	return (
		<SafeAreaProvider>
			<QueryClientProvider client={queryClient}>
				<SessionProvider>
					<StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
					<Navigator />
				</SessionProvider>
			</QueryClientProvider>
		</SafeAreaProvider>
	)
}
