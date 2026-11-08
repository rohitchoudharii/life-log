import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { env } from '../env'

/** The app account. Row-level security applies to it, so member data is reached through `asUser`. */
export const pool = new pg.Pool({ connectionString: env.DATABASE_URL })
export const db = drizzle(pool, { casing: 'snake_case' })

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/** Runs `fn` in a transaction that can only see and change rows of this member. */
export function asUser<T>(userId: string, fn: (tx: Tx) => Promise<T>) {
	return db.transaction(async (tx) => {
		await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`)
		return fn(tx)
	})
}

/** The owner account, for maintenance across all members (jobs, migrations). Never for requests. */
export const ownerPool = new pg.Pool({ connectionString: env.DATABASE_OWNER_URL, max: 2 })
export const ownerDb = drizzle(ownerPool, { casing: 'snake_case' })
