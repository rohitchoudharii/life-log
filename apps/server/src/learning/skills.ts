import type { Skill, SkillDetail } from '@life-log-club/contract'
import type { EntryData } from '@life-log-club/domain'
import { ORPCError } from '@orpc/server'
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm'
import { asUser, type Tx } from '../db/client'
import { entries, skills } from '../db/schema'
import { weekOf } from './progress'

type SkillRow = typeof skills.$inferSelect
type Practice = Extract<EntryData, { type: 'practice' }>['details']
type Session = { entryId: string; at: Date; text: string | null; details: Practice }

const WEEK = 7 * 24 * 60 * 60 * 1000
/** Weeks a skill's page shows, this one included. */
const SKILL_WEEKS = 8

const notFound = () => new ORPCError('NOT_FOUND', { message: 'That skill does not exist.' })

/** Practice sessions, newest first: of one skill, or of every skill. */
async function sessionsOf(tx: Tx, skillId?: string): Promise<Session[]> {
	const rows = await tx
		.select({ entryId: entries.id, at: entries.occurredAt, text: entries.text, details: entries.details })
		.from(entries)
		.where(and(eq(entries.type, 'practice'), isNull(entries.deletedAt), skillId ? sql`${entries.details}->>'skillId' = ${skillId}` : undefined))
		.orderBy(desc(entries.occurredAt), desc(entries.createdAt))
	return rows.map((r) => ({ ...r, details: r.details as Practice }))
}

const total = (sessions: Session[]) => ({ minutes: sessions.reduce((n, s) => n + s.details.minutes, 0), sessions: sessions.length })

function toSkill(row: SkillRow, sessions: Session[], now: Date): Skill {
	const week = weekOf(now).getTime()
	const last = sessions[0]
	return {
		id: row.id,
		name: row.name,
		goal: row.goal,
		weeklyMinutes: row.weeklyMinutes,
		archived: row.archivedAt !== null,
		week: total(sessions.filter((s) => s.at.getTime() >= week)),
		sessions: sessions.length,
		last: last ? { at: last.at, minutes: last.details.minutes, nextTime: last.details.nextTime ?? null } : null,
		createdAt: row.createdAt,
	}
}

async function find(tx: Tx, id: string) {
	const [row] = await tx.select().from(skills).where(eq(skills.id, id))
	if (!row) throw notFound()
	return row
}

const oneSkill = async (tx: Tx, row: SkillRow) => toSkill(row, await sessionsOf(tx, row.id), new Date())

/** The skill a practice entry is logged on, which must be the member's own and not archived. */
export async function practisedSkill(tx: Tx, skillId: string) {
	const [row] = await tx
		.select({ name: skills.name })
		.from(skills)
		.where(and(eq(skills.id, skillId), isNull(skills.archivedAt)))
	if (!row) throw new ORPCError('BAD_REQUEST', { message: 'That skill is not in your skills. It may have been archived.' })
	return row
}

export function listSkills(userId: string, now = new Date()) {
	return asUser(userId, async (tx) => {
		const rows = await tx.select().from(skills).where(isNull(skills.archivedAt)).orderBy(asc(skills.createdAt))
		const sessions = await sessionsOf(tx)
		return rows.map((row) => toSkill(row, sessions.filter((s) => s.details.skillId === row.id), now))
	})
}

/** One skill with its last 8 weeks and its trail of sessions. Archived skills can be opened too. */
export function getSkill(userId: string, id: string, now = new Date()): Promise<SkillDetail> {
	return asUser(userId, async (tx) => {
		const row = await find(tx, id)
		const sessions = await sessionsOf(tx, id)
		const thisWeek = weekOf(now).getTime()
		const weeks = Array.from({ length: SKILL_WEEKS }, (_, i) => {
			const start = thisWeek - (SKILL_WEEKS - 1 - i) * WEEK
			return { week: new Date(start), ...total(sessions.filter((s) => s.at.getTime() >= start && s.at.getTime() < start + WEEK)) }
		})
		const trail = sessions.map((s) => ({
			entryId: s.entryId,
			at: s.at,
			minutes: s.details.minutes,
			workedOn: s.details.workedOn ?? null,
			feedback: s.details.feedback ?? null,
			nextTime: s.details.nextTime ?? null,
			learned: s.text,
		}))
		return { ...toSkill(row, sessions, now), weeks, trail }
	})
}

const sameName = (tx: Tx, name: string, except: string) =>
	tx
		.select({ id: skills.id })
		.from(skills)
		.where(and(isNull(skills.archivedAt), sql`lower(${skills.name}) = lower(${name})`, sql`${skills.id} <> ${except}`))

const taken = (name: string) => new ORPCError('CONFLICT', { message: `“${name}” is in your skills already.` })

export function createSkill(userId: string, input: { id: string; name: string; goal?: string; weeklyMinutes?: number }) {
	return asUser(userId, async (tx) => {
		const [existing] = await tx.select().from(skills).where(eq(skills.id, input.id))
		if (existing) return oneSkill(tx, existing)
		if ((await sameName(tx, input.name, input.id)).length) throw taken(input.name)
		const [created] = await tx
			.insert(skills)
			.values({ id: input.id, userId, name: input.name, goal: input.goal || null, weeklyMinutes: input.weeklyMinutes ?? null })
			.onConflictDoNothing()
			.returning()
		// An id that belongs to another member is invisible here and can't be taken over.
		if (!created) throw new ORPCError('CONFLICT', { message: 'That skill id is taken. Try again.' })
		return oneSkill(tx, created)
	})
}

/** Changes a skill. A new name also shows on its past sessions. */
export function updateSkill(userId: string, input: { id: string; name?: string; goal?: string; weeklyMinutes?: number | null }) {
	return asUser(userId, async (tx) => {
		const row = await find(tx, input.id)
		if (input.name && input.name !== row.name && (await sameName(tx, input.name, row.id)).length) throw taken(input.name)
		const [updated] = await tx
			.update(skills)
			.set({
				...(input.name !== undefined && { name: input.name }),
				...(input.goal !== undefined && { goal: input.goal || null }),
				...(input.weeklyMinutes !== undefined && { weeklyMinutes: input.weeklyMinutes }),
			})
			.where(eq(skills.id, row.id))
			.returning()
		if (input.name && input.name !== row.name)
			await tx
				.update(entries)
				.set({ details: sql`jsonb_set(${entries.details}, '{skill}', to_jsonb(${input.name}::text))` })
				.where(and(eq(entries.type, 'practice'), sql`${entries.details}->>'skillId' = ${row.id}`))
		return oneSkill(tx, updated!)
	})
}

export function archiveSkill(userId: string, id: string, at: Date | null) {
	return asUser(userId, async (tx) => {
		const row = await find(tx, id)
		if (!at && (await sameName(tx, row.name, row.id)).length) throw taken(row.name)
		const [updated] = await tx.update(skills).set({ archivedAt: at }).where(eq(skills.id, row.id)).returning()
		return oneSkill(tx, updated!)
	})
}
