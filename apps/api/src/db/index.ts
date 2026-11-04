import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { fileURLToPath } from 'node:url'
import { env } from '../env'
import * as schema from './schema'

const client = postgres(env.DATABASE_URL, { onnotice: () => {} })
export const db = drizzle(client, { schema })
export type Db = typeof db

export const runMigrations = () =>
	migrate(db, { migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)) })

export * as t from './schema'
