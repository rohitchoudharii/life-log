import { contract } from '@life-log-club/contract'
import { implement, ORPCError } from '@orpc/server'
import { loadSession, sessionCookie } from './auth/sessions'
import type { Context } from './context'

export const os = implement(contract).$context<Context>()

/** Procedures built on `authed` run only for a signed-in user, and see `user` and `session`. */
export const authed = os.use(async ({ context, next }) => {
	const check = await loadSession(context.token)
	if (check.kind !== 'ok') {
		if (context.token) context.resHeaders.append('set-cookie', sessionCookie(null))
		throw new ORPCError('UNAUTHORIZED', {
			message: check.kind === 'expired' ? 'You have been away for 30 days. Sign in again.' : 'Sign in first.',
		})
	}
	return next({ context: { user: check.user, session: check.session } })
})
