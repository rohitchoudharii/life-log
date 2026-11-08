import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { env } from '../env'

const MIGRATIONS = new URL('../../drizzle', import.meta.url).pathname

/**
 * Creates the database and the app account when they are missing, applies migrations, and
 * grants the app account what it needs. A fresh machine only needs `pnpm db:up` and `pnpm dev`.
 * The app account doesn't own the tables, so row-level security applies to every API query.
 */
export async function prepareDatabase() {
	const owner = new URL(env.DATABASE_OWNER_URL)
	const app = new URL(env.DATABASE_URL)
	const name = decodeURIComponent(owner.pathname.slice(1))
	const role = pg.escapeIdentifier(decodeURIComponent(app.username))

	const maintenance = new URL(owner)
	maintenance.pathname = '/postgres'
	const admin = new pg.Client({ connectionString: maintenance.toString() })
	await admin.connect()
	try {
		const db = await admin.query('select 1 from pg_database where datname = $1', [name])
		if (!db.rowCount) await admin.query(`create database ${pg.escapeIdentifier(name)}`)
		const r = await admin.query('select 1 from pg_roles where rolname = $1', [decodeURIComponent(app.username)])
		if (!r.rowCount)
			await admin.query(`create role ${role} login password ${pg.escapeLiteral(decodeURIComponent(app.password))}`)
	} finally {
		await admin.end()
	}

	const ownerPool = new pg.Pool({ connectionString: env.DATABASE_OWNER_URL, max: 1 })
	try {
		await migrate(drizzle(ownerPool), { migrationsFolder: MIGRATIONS })
		await ownerPool.query(`
			grant usage on schema public to ${role};
			grant select, insert, update, delete on all tables in schema public to ${role};
			grant usage, select on all sequences in schema public to ${role};
			revoke update, delete, truncate on audit_log from ${role};
		`)
	} finally {
		await ownerPool.end()
	}
}
