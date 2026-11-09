import { ownerPool, pool } from '../db/client'
import { prepareDatabase } from '../db/prepare'
import { replaySchedules } from '../learning/replay'

// Usage: pnpm db:replay-schedules
// Works every card's schedule out again from its answers with the current scheduler, and prints
// what changed. Safe to run more than once. To try it on a copy first, point DATABASE_OWNER_URL
// and DATABASE_URL at the copy.
await prepareDatabase()
const report = await replaySchedules()
await Promise.all([pool.end(), ownerPool.end()])
console.log(JSON.stringify(report, null, 2))
