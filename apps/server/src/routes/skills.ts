import { archiveSkill, createSkill, getSkill, listSkills, updateSkill } from '../learning/skills'
import { authed } from '../orpc'

export const skillRoutes = {
	list: authed.skills.list.handler(({ context }) => listSkills(context.user.id)),
	get: authed.skills.get.handler(({ input, context }) => getSkill(context.user.id, input.id)),
	create: authed.skills.create.handler(({ input, context }) => createSkill(context.user.id, input)),
	update: authed.skills.update.handler(({ input, context }) => updateSkill(context.user.id, input)),
	archive: authed.skills.archive.handler(async ({ input, context }) => {
		await archiveSkill(context.user.id, input.id, new Date())
		return { ok: true as const }
	}),
	restore: authed.skills.restore.handler(({ input, context }) => archiveSkill(context.user.id, input.id, null)),
}
