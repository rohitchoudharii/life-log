import { getTeach, replyTeach, startTeach } from '../learning/teach'
import { authed } from '../orpc'

export const teachRoutes = {
	start: authed.teach.start.handler(({ input, context }) => startTeach(context.user.id, input)),
	reply: authed.teach.reply.handler(({ input, context }) => replyTeach(context.user.id, input)),
	get: authed.teach.get.handler(({ input, context }) => getTeach(context.user.id, input.id)),
}
