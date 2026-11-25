/**
 * Minimal SQL access layer with two drivers:
 *   - Postgres (`pg` pool) for production: DATABASE_URL=postgres://…
 *   - SQLite (`node:sqlite`, built into Node 22+) for local demo and tests: DATABASE_URL=sqlite:./data/app.db or sqlite::memory:
 * Queries are written once with Postgres-style `$1` placeholders.
 *
 * Tenant isolation is enforced twice:
 *   1. every repository method takes a tenant id and every query filters on tenant_id;
 *   2. on Postgres, `tenantTx(tenantId, …)` sets `app.tenant_id` for the transaction and row-level
 *      security policies (migration 002) hide every other tenant's rows, so a query that forgot
 *      the filter still cannot read or write another tenant's data.
 */
export type Dialect = 'pg' | 'sqlite'
export type Row = Record<string, unknown>

export interface Queryer {
  query<T extends Row = Row>(text: string, params?: unknown[]): Promise<T[]>
}

export interface Db extends Queryer {
  readonly dialect: Dialect
  /** Transaction with no tenant set (migrations, users table). */
  tx<T>(fn: (q: Queryer) => Promise<T>): Promise<T>
  /** Transaction bound to one tenant (RLS on Postgres). */
  tenantTx<T>(tenantId: string, fn: (q: Queryer) => Promise<T>): Promise<T>
  close(): Promise<void>
}

/** A unique / primary-key constraint was violated (driver-independent). */
export class UniqueViolation extends Error {
  readonly constraint: string
  constructor(constraint: string, message: string) {
    super(message)
    this.name = 'UniqueViolation'
    this.constraint = constraint
  }
}

/** Constraint name for Postgres; the column list for SQLite ("bookings.tenant_id, bookings.ref"). */
function normalize(e: unknown): unknown {
  const err = e as { code?: string; constraint?: string; message?: string; errcode?: number; errstr?: string }
  if (err?.code === '23505') return new UniqueViolation(err.constraint ?? '', err.message ?? 'unique violation')
  if (err?.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed|PRIMARY KEY/i.test(err.message ?? '')) {
    return new UniqueViolation((err.message ?? '').replace(/^.*constraint failed:\s*/i, ''), err.message ?? 'unique violation')
  }
  return e
}

export function redactUrl(url: string): string {
  return url.replace(/\/\/([^:/@]+)(:[^@]*)?@/, '//$1:***@')
}

export async function connect(url: string, o: { max?: number } = {}): Promise<Db> {
  if (/^postgres(ql)?:\/\//i.test(url)) return connectPg(url, o.max ?? 10)
  if (/^sqlite:/i.test(url)) return connectSqlite(url.replace(/^sqlite:(\/\/)?/i, '') || ':memory:')
  throw new Error('DATABASE_URL must start with postgres:// or sqlite:')
}

async function connectPg(url: string, max: number): Promise<Db> {
  const { default: pg } = await import('pg')
  // DATE columns come back as "YYYY-MM-DD" strings (no timezone shift), NUMERIC as numbers
  pg.types.setTypeParser(1082, (v: string) => v)
  pg.types.setTypeParser(1700, (v: string) => Number(v))
  pg.types.setTypeParser(20, (v: string) => Number(v))
  const pool = new pg.Pool({ connectionString: url, max, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 })
  const q = (c: { query: (t: string, p?: unknown[]) => Promise<{ rows: unknown[] }> }): Queryer => ({
    async query<T extends Row>(text: string, params: unknown[] = []) {
      try {
        return (await c.query(text, params)).rows as T[]
      } catch (e) {
        throw normalize(e)
      }
    },
  })
  const run = async <T>(tenantId: string | null, fn: (q: Queryer) => Promise<T>): Promise<T> => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      if (tenantId !== null) await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId])
      const out = await fn(q(client))
      await client.query('COMMIT')
      return out
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw normalize(e)
    } finally {
      client.release()
    }
  }
  return {
    dialect: 'pg',
    query: q(pool).query,
    tx: (fn) => run(null, fn),
    tenantTx: (tenantId, fn) => run(tenantId, fn),
    close: () => pool.end(),
  }
}

async function connectSqlite(file: string): Promise<Db> {
  const { DatabaseSync } = await import('node:sqlite')
  if (file !== ':memory:') {
    const { mkdirSync } = await import('node:fs')
    const { dirname } = await import('node:path')
    mkdirSync(dirname(file), { recursive: true })
  }
  const db = new DatabaseSync(file)
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;')
  // $1 -> ?1 (SQLite numbered parameters); booleans -> 0/1
  const toSqlite = (text: string) => text.replace(/\$(\d+)/g, '?$1')
  const bind = (p: unknown[]) => p.map((v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v === undefined ? null : v)) as Array<string | number | null>
  const q: Queryer = {
    async query<T extends Row>(text: string, params: unknown[] = []) {
      try {
        const st = db.prepare(toSqlite(text))
        return /^\s*(select|with|insert[\s\S]*returning|update[\s\S]*returning|delete[\s\S]*returning)/i.test(text) ? (st.all(...bind(params)) as T[]) : (st.run(...bind(params)), [])
      } catch (e) {
        throw normalize(e)
      }
    },
  }
  // node:sqlite is synchronous on one connection: serialize transactions so they never interleave
  let chain: Promise<unknown> = Promise.resolve()
  const run = <T>(fn: (q: Queryer) => Promise<T>): Promise<T> => {
    const next = chain.then(async () => {
      db.exec('BEGIN IMMEDIATE')
      try {
        const out = await fn(q)
        db.exec('COMMIT')
        return out
      } catch (e) {
        db.exec('ROLLBACK')
        throw normalize(e)
      }
    })
    chain = next.catch(() => {})
    return next
  }
  return {
    dialect: 'sqlite',
    // plain queries also wait for an open transaction to finish
    query: <T extends Row>(text: string, params?: unknown[]) => {
      const next = chain.then(() => q.query<T>(text, params))
      chain = next.catch(() => {})
      return next
    },
    tx: run,
    tenantTx: (_tenantId, fn) => run(fn),
    close: async () => {
      await chain
      db.close()
    },
  }
}
