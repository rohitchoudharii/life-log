import { asUser } from '../db/client'
import { requeueWaiting } from '../jobs'
import { withinBudget } from '../learning/ai'
import { preferencesOf, updatePreferences } from '../learning/preferences'
import { authed } from '../orpc'

const shown = ({ aiMonthlyBudgetUsd }: { aiMonthlyBudgetUsd: number }) => ({ aiMonthlyBudgetUsd })

export const preferencesRoutes = {
	get: authed.preferences.get.handler(({ context }) => asUser(context.user.id, async (tx) => shown(await preferencesOf(tx, context.user.id)))),
	update: authed.preferences.update.handler(async ({ input, context }) => {
		const userId = context.user.id
		const prefs = await asUser(userId, (tx) => updatePreferences(tx, userId, input))
		if (input.aiMonthlyBudgetUsd !== undefined && (await withinBudget(userId))) await requeueWaiting(userId, ['paused'])
		return shown(prefs)
	}),
}
