import type { Contract } from '@life-log-club/contract'
import { createORPCClient, ORPCError } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import { SimpleCsrfProtectionLinkPlugin } from '@orpc/client/plugins'
import type { ContractRouterClient } from '@orpc/contract'

export const APP_ORIGIN = __APP_ORIGIN__

// The member's session cookie for the app goes with every call: Chrome sends it because the
// extension has access to the app's site, so the extension needs no sign-in of its own.
const link = new RPCLink({
	url: `${APP_ORIGIN}/rpc`,
	plugins: [new SimpleCsrfProtectionLinkPlugin()],
	fetch: (request, init) => fetch(request, { ...init, credentials: 'include' }),
})

export const client: ContractRouterClient<Contract> = createORPCClient(link)

export const UNREACHABLE = "Can't reach Life Log Club. Check your connection and try again."

/** The message to show the member for a failed call. */
export const errorMessage = (error: unknown) =>
	error instanceof ORPCError
		? error.code === 'INTERNAL_SERVER_ERROR'
			? 'Something went wrong. Try again.'
			: error.message
		: UNREACHABLE
