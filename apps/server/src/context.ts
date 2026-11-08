import type { RequestInfo } from './auth/audit'

/** What every API call knows about its request, plus a place to set cookies on the response. */
export type Context = {
	token: string | undefined
	req: RequestInfo
	resHeaders: Headers
}
