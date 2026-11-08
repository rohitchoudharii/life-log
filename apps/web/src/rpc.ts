import type { Contract } from '@life-log-club/contract'
import { createORPCClient, ORPCError } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import { SimpleCsrfProtectionLinkPlugin } from '@orpc/client/plugins'
import type { ContractRouterClient } from '@orpc/contract'
import { createTanstackQueryUtils } from '@orpc/tanstack-query'

const link = new RPCLink({
	url: `${window.location.origin}/rpc`,
	plugins: [new SimpleCsrfProtectionLinkPlugin()],
})

export const client: ContractRouterClient<Contract> = createORPCClient(link)
export const orpc = createTanstackQueryUtils(client)

export const isUnauthorized = (error: unknown) => error instanceof ORPCError && error.code === 'UNAUTHORIZED'

/** The message to show a person for a failed call. */
export const errorMessage = (error: unknown) =>
	error instanceof ORPCError && error.code !== 'INTERNAL_SERVER_ERROR'
		? error.message
		: 'Something went wrong. Try again.'
