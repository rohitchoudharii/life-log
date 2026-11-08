import { sql } from './db'

// Start every run from empty tables, so failed sign-ins from an earlier run can't lock this one
// out. On the very first run the database doesn't exist yet; the API creates it.
export default async function globalSetup() {
	try {
		await sql(`do $$ declare tables text; begin
			select string_agg(format('%I', tablename), ', ') into tables from pg_tables where schemaname = 'public';
			if tables is not null then execute 'truncate ' || tables || ' cascade'; end if;
		end $$`)
	} catch (error) {
		if ((error as { code?: string }).code !== '3D000') throw error
	}
}
