import * as Notifications from 'expo-notifications'
import { AndroidImportance } from 'expo-notifications'
import { Platform } from 'react-native'

export const remindersSupported = Platform.OS !== 'web'

const DAILY = 'daily-reminder'
const SESSION_END = 'session-end'

if (remindersSupported)
	Notifications.setNotificationHandler({
		handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
	})

async function allowed() {
	if (Platform.OS === 'android')
		await Notifications.setNotificationChannelAsync('reminders', { name: 'Study reminders', importance: AndroidImportance.HIGH })
	const { granted } = await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowSound: true } })
	return granted
}

/**
 * Schedules one daily local reminder at "HH:MM", or none when time is null.
 * Returns false when the user has notifications turned off; the app then just waits for them.
 */
export async function scheduleDailyReminder(time: string | null): Promise<boolean> {
	if (!remindersSupported) return false
	await Notifications.cancelScheduledNotificationAsync(DAILY)
	if (!time) return true
	if (!(await allowed())) return false
	const [hour, minute] = time.split(':').map(Number)
	await Notifications.scheduleNotificationAsync({
		identifier: DAILY,
		content: { title: 'Time to practice', body: 'Your recalls are waiting. A few minutes keeps them fresh.' },
		trigger: { type: Notifications.SchedulableTriggerInputTypes.DAILY, hour: hour!, minute: minute!, channelId: 'reminders' },
	})
	return true
}

/** Tells the user their focus time is up, even if the app is in the background. */
export async function scheduleSessionEnd(at: Date) {
	if (!remindersSupported || at.getTime() <= Date.now() || !(await allowed())) return
	await Notifications.scheduleNotificationAsync({
		identifier: SESSION_END,
		content: { title: 'Focus time is up', body: 'Tell Peak where you stopped, then take your recall test.' },
		trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: at, channelId: 'reminders' },
	})
}

export async function cancelSessionEnd() {
	if (remindersSupported) await Notifications.cancelScheduledNotificationAsync(SESSION_END)
}
