import type { Contract } from '@life-log-club/contract'
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import { SimpleCsrfProtectionLinkPlugin } from '@orpc/client/plugins'
import type { ContractRouterClient } from '@orpc/contract'
import { invite, newEmail } from './db'
import { API_PORT } from './env'

export const PASSWORD = 'swallows come home'

/** An API client for a new member, signed in, that keeps its session cookie like a browser. */
export async function newMember(name = 'Rohit') {
	let cookie = ''
	const link = new RPCLink({
		url: `http://localhost:${API_PORT}/rpc`,
		plugins: [new SimpleCsrfProtectionLinkPlugin()],
		fetch: async (request, init) => {
			if (cookie) request.headers.set('cookie', cookie)
			const res = await fetch(request, init)
			const set = res.headers.getSetCookie().find((c) => c.startsWith('llc_session='))
			if (set) cookie = set.split(';')[0]!
			return res
		},
	})
	const client: ContractRouterClient<Contract> = createORPCClient(link)
	const email = newEmail()
	const token = (await invite(email)).split('#')[1]!
	const user = await client.auth.acceptInvite({ token, name, password: PASSWORD })
	return { client, email, user }
}
