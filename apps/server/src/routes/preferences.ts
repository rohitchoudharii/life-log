import { asUser } from '../db/client'
import { preferencesOf, updatePreferences } from '../learning/preferences'
import { authed } from '../orpc'

const shown = ({ aiMonthlyBudgetUsd }: { aiMonthlyBudgetUsd: number }) => ({ aiMonthlyBudgetUsd })

export const preferencesRoutes = {
	get: authed.preferences.get.handler(({ context }) => asUser(context.user.id, async (tx) => shown(await preferencesOf(tx, context.user.id)))),
	update: authed.preferences.update.handler(({ input, context }) =>
		asUser(context.user.id, async (tx) => shown(await updatePreferences(tx, context.user.id, input))),
	),
}
