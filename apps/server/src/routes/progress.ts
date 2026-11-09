import { asUser } from '../db/client'
import { mindSummary, progressSummary } from '../learning/progress'
import { authed } from '../orpc'

export const mindRoutes = {
	summary: authed.mind.summary.handler(({ context }) => asUser(context.user.id, (tx) => mindSummary(tx))),
}

export const progressRoutes = {
	summary: authed.progress.summary.handler(({ input, context }) => asUser(context.user.id, (tx) => progressSummary(tx, context.user.id, input.days))),
}
