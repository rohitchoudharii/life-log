import { oc } from '@orpc/contract'
import { z } from 'zod'

export const contract = {
	system: {
		health: oc.output(z.object({ server: z.literal('ok'), database: z.enum(['ok', 'down']) })),
	},
}

export type Contract = typeof contract
