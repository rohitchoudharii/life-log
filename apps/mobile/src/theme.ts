import * as SecureStore from 'expo-secure-store'
import { useSyncExternalStore } from 'react'
import { Platform, useColorScheme } from 'react-native'

// Editorial black and white. Dark mode is the exact inverse of every light color.
const light = {
	bg: '#FFFFFF',
	fg: '#000000',
	sub: '#6B6B6B',
	tile: '#FFFFFF',
	ring: '#D9D9D9',
	track: '#E6E6E6',
}

const invert = (hex: string) =>
	'#' + (0xffffff ^ parseInt(hex.slice(1), 16)).toString(16).padStart(6, '0').toUpperCase()

const dark = Object.fromEntries(Object.entries(light).map(([k, v]) => [k, invert(v)])) as typeof light

export type Colors = typeof light

export const font = {
	regular: 'Manrope_400Regular',
	medium: 'Manrope_500Medium',
	semibold: 'Manrope_600SemiBold',
}

export const radius = 6
export const hairline = 1

/** Spacing on a 4px scale: tight within a group, roomy between groups. */
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, screenX: 20, screenTop: 28 }

/** 'system' follows the phone or browser setting; the others override it on this device. */
export type Appearance = 'system' | 'light' | 'dark'

const APPEARANCE_KEY = 'lifelogclub.appearance'
let appearance: Appearance = 'system'
const listeners = new Set<() => void>()
const isAppearance = (v: unknown): v is Appearance => v === 'system' || v === 'light' || v === 'dark'

/** Reads the saved choice once at startup. */
export async function loadAppearance() {
	const saved = Platform.OS === 'web' ? localStorage.getItem(APPEARANCE_KEY) : await SecureStore.getItemAsync(APPEARANCE_KEY)
	if (isAppearance(saved)) setAppearance(saved, false)
}

export function setAppearance(next: Appearance, save = true) {
	appearance = next
	listeners.forEach((l) => l())
	if (!save) return
	if (Platform.OS === 'web') localStorage.setItem(APPEARANCE_KEY, next)
	else void SecureStore.setItemAsync(APPEARANCE_KEY, next)
}

const subscribe = (l: () => void) => {
	listeners.add(l)
	return () => listeners.delete(l)
}

export const useAppearance = () => useSyncExternalStore(subscribe, () => appearance)

export function useScheme(): 'light' | 'dark' {
	const system = useColorScheme()
	const chosen = useAppearance()
	return chosen === 'system' ? (system === 'dark' ? 'dark' : 'light') : chosen
}

export function useColors(): Colors {
	return useScheme() === 'dark' ? dark : light
}
