import { schedulerFor } from '@life-log-club/domain'
import { preferences } from '../db/schema'
import type { Tx } from '../db/client'

export type Preferences = Omit<typeof preferences.$inferSelect, 'userId' | 'updatedAt'>

/** The member's preferences, or the defaults when they have changed none. */
export async function preferencesOf(tx: Tx, userId: string): Promise<Preferences> {
	const [row] = await tx.select().from(preferences)
	if (row) return row
	// The column defaults are the source of truth; reading them back avoids a second copy here.
	const [defaults] = await tx.insert(preferences).values({ userId }).onConflictDoNothing().returning()
	return defaults ?? (await tx.select().from(preferences))[0]!
}

/** Changes some preferences and returns them all. */
export async function updatePreferences(tx: Tx, userId: string, change: Partial<Preferences>): Promise<Preferences> {
	await preferencesOf(tx, userId)
	const [row] = await tx
		.update(preferences)
		.set({ ...change, updatedAt: new Date() })
		.returning()
	return row!
}

/** The scheduler for the member's answers: their target recall, and their own FSRS parameters once tuned. */
export async function schedulerOf(tx: Tx, userId: string) {
	const { desiredRetention, fsrsWeights } = await preferencesOf(tx, userId)
	return schedulerFor(desiredRetention, fsrsWeights)
}
