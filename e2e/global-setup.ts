import { sql } from './db'

// Start every run from empty sign-in tables, so failed sign-ins from an earlier run can't
// lock this one out. On the very first run the database doesn't exist yet; the API creates it.
export default async function globalSetup() {
	try {
		await sql(`do $$ begin
			if to_regclass('public.users') is not null then
				truncate users, invites, sessions, audit_log cascade;
			end if;
		end $$`)
	} catch (error) {
		if ((error as { code?: string }).code !== '3D000') throw error
	}
}
