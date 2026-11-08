import { bigint, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

const id = () => uuid().primaryKey().defaultRandom()
const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow()

// Sign-in tables are read before anyone is known (by email or session token), so they have no
// row-level security. Only the auth module touches them.

export const users = pgTable('users', {
	id: id(),
	email: text().notNull().unique(),
	name: text().notNull(),
	/** Null until the person opens their invite link and picks a password. */
	passwordHash: text(),
	createdAt: createdAt(),
	disabledAt: timestamp({ withTimezone: true }),
})

/** An invite link sets or resets the password for one email. Only the owner makes them, from the command line. */
export const invites = pgTable('invites', {
	id: id(),
	email: text().notNull(),
	tokenHash: text().notNull().unique(),
	expiresAt: timestamp({ withTimezone: true }).notNull(),
	usedAt: timestamp({ withTimezone: true }),
	createdAt: createdAt(),
})

/** One row per signed-in browser or device; this is the device list. */
export const sessions = pgTable(
	'sessions',
	{
		id: id(),
		userId: uuid()
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		tokenHash: text().notNull().unique(),
		label: text().notNull(),
		createdAt: createdAt(),
		lastSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
		revokedAt: timestamp({ withTimezone: true }),
	},
	(t) => [index().on(t.userId)],
)

/** Every sign-in event. The app account can add and read rows, never change or delete them. */
export const auditLog = pgTable(
	'audit_log',
	{
		id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
		event: text().notNull(),
		userId: uuid(),
		email: text(),
		ip: text(),
		userAgent: text(),
		meta: jsonb().$type<Record<string, unknown>>(),
		at: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [index().on(t.event, t.email, t.at), index().on(t.event, t.ip, t.at)],
)
