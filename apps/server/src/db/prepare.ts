import pg from 'pg'
import { env } from '../env'

/**
 * Creates the database and the app account when they are missing, so a fresh machine only
 * needs `pnpm db:up` and `pnpm dev`. The app account is not the owner, so row-level security
 * applies to every query the API makes.
 */
export async function prepareDatabase() {
	const owner = new URL(env.DATABASE_OWNER_URL)
	const app = new URL(env.DATABASE_URL)
	const name = decodeURIComponent(owner.pathname.slice(1))
	const role = decodeURIComponent(app.username)

	const maintenance = new URL(owner)
	maintenance.pathname = '/postgres'
	const admin = new pg.Client({ connectionString: maintenance.toString() })
	await admin.connect()
	try {
		const db = await admin.query('select 1 from pg_database where datname = $1', [name])
		if (!db.rowCount) await admin.query(`create database ${pg.escapeIdentifier(name)}`)
		const r = await admin.query('select 1 from pg_roles where rolname = $1', [role])
		if (!r.rowCount)
			await admin.query(
				`create role ${pg.escapeIdentifier(role)} login password ${pg.escapeLiteral(decodeURIComponent(app.password))}`,
			)
	} finally {
		await admin.end()
	}
}
