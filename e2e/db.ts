import { createHash, randomBytes, randomUUID } from 'node:crypto'
import pg from 'pg'
import { e2eEnv } from './env'

/** Runs one query as the database owner against the e2e database. */
export async function sql<T extends pg.QueryResultRow>(text: string, values: unknown[] = []) {
	const client = new pg.Client({ connectionString: e2eEnv.DATABASE_OWNER_URL })
	await client.connect()
	try {
		return (await client.query<T>(text, values)).rows
	} finally {
		await client.end()
	}
}

/** A fresh email for each test, so tests running side by side never share an account. */
export const newEmail = () => `member-${randomUUID().slice(0, 8)}@example.com`

/** Creates an invite the same way `pnpm invite` does, and returns its link path. */
export async function invite(email: string) {
	const token = randomBytes(32).toString('base64url')
	await sql(`insert into invites (email, token_hash, expires_at) values ($1, $2, now() + interval '7 days')`, [
		email,
		createHash('sha256').update(token).digest('hex'),
	])
	return `/welcome#${token}`
}

/** Pretends every device of this account was last used `days` ago. */
export async function ageSessions(email: string, days: number) {
	await sql(
		`update sessions set last_seen_at = now() - make_interval(days => $2)
		 where user_id = (select id from users where email = $1)`,
		[email, days],
	)
}

/** Puts a card past the steps, with an FSRS memory last reviewed `daysAgo`, and due `dueDaysAgo`. */
export const graduate = (id: string, stability: number, daysAgo: number, dueDaysAgo: number) =>
	sql(
		`update cards set due_at = now() - make_interval(days => $4), state = jsonb_build_object(
			'step', null, 'relearning', null, 'reps', 5, 'lapses', 0,
			'memory', jsonb_build_object('stability', $2::float, 'difficulty', 5),
			'lastReviewAt', to_char((now() - make_interval(days => $3)) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
		) where id = $1`,
		[id, stability, daysAgo, dueDaysAgo],
	)
