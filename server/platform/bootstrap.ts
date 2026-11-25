/**
 * Wires storage and auth from validated env (server only; never imported by the browser bundle).
 *   DATABASE_URL set   -> SQL store + call log + users (Postgres or SQLite), migrations on boot
 *   DATABASE_URL unset -> in-memory store (demo / tests)
 *   AUTH_SECRET set    -> login required for /api/v1/tenants/*, roles enforced
 */
import { createAuth, type Auth } from '../auth/http.ts'
import { hashPassword } from '../auth/password.ts'
import { MemoryUserRepo, SqlUserRepo, type UserRepo } from '../auth/users.ts'
import { SqlBookingStore } from '../db/bookingRepo.ts'
import { SqlCallLog } from '../db/callRepo.ts'
import { migrate } from '../db/migrations.ts'
import { connect, redactUrl, type Db } from '../db/sql.ts'
import { MemoryCallLog, type CallLog } from './callLog.ts'
import type { PlatformEnv } from './config.ts'
import type { Logger } from './logger.ts'
import { MemoryBookingStore, type BookingStore } from './store.ts'
import type { Tenant } from './tenant.ts'

export interface Persistence {
  storage: 'memory' | 'postgres' | 'sqlite'
  db: Db | null
  store: BookingStore
  callLog: CallLog
  users: UserRepo
  dbReady?: () => Promise<boolean>
  close(): Promise<void>
}

export async function createPersistence(config: Pick<PlatformEnv, 'databaseUrl' | 'migrateOnBoot'>, logger: Logger): Promise<Persistence> {
  if (!config.databaseUrl) {
    return { storage: 'memory', db: null, store: new MemoryBookingStore(), callLog: new MemoryCallLog(), users: new MemoryUserRepo(), close: async () => {} }
  }
  const db = await connect(config.databaseUrl)
  if (config.migrateOnBoot) {
    const applied = await migrate(db)
    logger.info('db_migrated', { applied, url: redactUrl(config.databaseUrl) })
  }
  return {
    storage: db.dialect === 'pg' ? 'postgres' : 'sqlite',
    db,
    store: new SqlBookingStore(db),
    callLog: new SqlCallLog(db),
    users: new SqlUserRepo(db),
    dbReady: async () => (await db.query('SELECT 1 AS ok')).length === 1,
    close: () => db.close(),
  }
}

export function createAuthFromEnv(config: Pick<PlatformEnv, 'authSecret' | 'authTtlSec' | 'cookieSecure'>, users: UserRepo, logger: Logger): Auth | undefined {
  if (!config.authSecret) return undefined
  return createAuth({ users, secret: config.authSecret, ttlSec: config.authTtlSec, secureCookie: config.cookieSecure, logger })
}

/**
 * Demo / first-run users from env (idempotent upsert; passwords are never logged):
 *   SEED_ADMIN_EMAIL + SEED_ADMIN_PASSWORD
 *   SEED_STAFF_USERS="front@erth.example=erth-abu-dhabi,desk@mm.example=mm-dental-care" + SEED_STAFF_PASSWORD
 */
export async function seedUsersFromEnv(users: UserRepo, tenants: Map<string, Tenant>, env: Record<string, string | undefined> = process.env): Promise<string[]> {
  const out: string[] = []
  if (env.SEED_ADMIN_EMAIL && env.SEED_ADMIN_PASSWORD) {
    await users.upsert({ email: env.SEED_ADMIN_EMAIL, passwordHash: await hashPassword(env.SEED_ADMIN_PASSWORD), role: 'admin', tenantId: null })
    out.push(`${env.SEED_ADMIN_EMAIL} (admin)`)
  }
  if (env.SEED_STAFF_USERS && env.SEED_STAFF_PASSWORD) {
    const hash = await hashPassword(env.SEED_STAFF_PASSWORD)
    for (const pair of env.SEED_STAFF_USERS.split(',').map((s) => s.trim()).filter(Boolean)) {
      const [email, tenantId] = pair.split('=').map((s) => s.trim())
      if (!email || !tenantId || !tenants.has(tenantId)) throw new Error(`SEED_STAFF_USERS: "${pair}" must be email=<known tenant id>`)
      await users.upsert({ email, passwordHash: hash, role: 'staff', tenantId })
      out.push(`${email} (staff: ${tenantId})`)
    }
  }
  return out
}
