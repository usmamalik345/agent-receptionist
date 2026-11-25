/**
 * Versioned schema migrations, applied in order inside a transaction each and recorded in
 * schema_migrations. Written once; `{TS}` / `{DATE}` map to the right column type per dialect.
 * Never edit an applied migration: add a new one.
 */
import type { Db, Dialect } from './sql.ts'

interface Migration {
  id: string
  /** null = not applicable to this dialect */
  sql: (d: Dialect) => string | null
}

const types = (d: Dialect, s: string) => s.replaceAll('{TS}', d === 'pg' ? 'TIMESTAMPTZ' : 'TEXT').replaceAll('{DATE}', d === 'pg' ? 'DATE' : 'TEXT')

const TENANT_TABLES = ['bookings', 'room_nights', 'calls', 'call_turns']

export const MIGRATIONS: Migration[] = [
  {
    id: '001_init',
    sql: (d) => types(d, `
CREATE TABLE bookings (
  tenant_id   TEXT NOT NULL,
  ref         TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('appointment', 'room')),
  status      TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled')),
  name        TEXT NOT NULL,
  phone       TEXT NOT NULL,
  treatment   TEXT,
  location    TEXT,
  appt_date   {DATE},
  appt_time   TEXT,
  room_type   TEXT,
  check_in    {DATE},
  check_out   {DATE},
  guests      INTEGER,
  total_price NUMERIC(12, 2),
  call_id     TEXT,
  created_at  {TS} NOT NULL,
  PRIMARY KEY (tenant_id, ref),
  CHECK (kind <> 'appointment' OR (location IS NOT NULL AND appt_date IS NOT NULL AND appt_time IS NOT NULL)),
  CHECK (kind <> 'room' OR (room_type IS NOT NULL AND check_in IS NOT NULL AND check_out IS NOT NULL AND check_out > check_in))
);
-- Double-booking guard at the database: one confirmed appointment per tenant/location/date/time
CREATE UNIQUE INDEX bookings_one_per_slot ON bookings (tenant_id, location, appt_date, appt_time) WHERE kind = 'appointment' AND status = 'confirmed';
CREATE INDEX bookings_tenant_created ON bookings (tenant_id, created_at);

-- Room inventory: one row per sold room-night. unit is 1..count of that room type (checked by the app);
-- the primary key makes it impossible to sell the same unit twice on the same night (no overselling under races).
CREATE TABLE room_nights (
  tenant_id   TEXT NOT NULL,
  room_type   TEXT NOT NULL,
  night       {DATE} NOT NULL,
  unit        INTEGER NOT NULL CHECK (unit >= 1),
  booking_ref TEXT NOT NULL,
  PRIMARY KEY (tenant_id, room_type, night, unit),
  FOREIGN KEY (tenant_id, booking_ref) REFERENCES bookings (tenant_id, ref) ON DELETE CASCADE
);

-- Calls and turns: what ops needs (agent, intent, tools, outcome, latency). Never the caller's words.
CREATE TABLE calls (
  tenant_id   TEXT NOT NULL,
  id          TEXT NOT NULL,
  started_at  {TS} NOT NULL,
  ended_at    {TS},
  turns       INTEGER NOT NULL DEFAULT 0,
  escalated   SMALLINT NOT NULL DEFAULT 0,
  outcome     TEXT CHECK (outcome IN ('booked', 'transferred')),
  booking_ref TEXT,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX calls_tenant_started ON calls (tenant_id, started_at);

CREATE TABLE call_turns (
  tenant_id     TEXT NOT NULL,
  call_id       TEXT NOT NULL,
  turn          INTEGER NOT NULL,
  trace_id      TEXT NOT NULL,
  agent         TEXT NOT NULL,
  intent        TEXT NOT NULL,
  tools         TEXT NOT NULL DEFAULT '[]',
  escalated     SMALLINT NOT NULL DEFAULT 0,
  guard_blocked SMALLINT NOT NULL DEFAULT 0,
  booking_ref   TEXT,
  latency_ms    INTEGER NOT NULL,
  reply_chars   INTEGER NOT NULL,
  at            {TS} NOT NULL,
  PRIMARY KEY (tenant_id, call_id, turn),
  FOREIGN KEY (tenant_id, call_id) REFERENCES calls (tenant_id, id) ON DELETE CASCADE
);

-- Console users. admin: every tenant (tenant_id NULL); staff: exactly one tenant.
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin', 'staff')),
  tenant_id     TEXT,
  disabled      SMALLINT NOT NULL DEFAULT 0,
  created_at    {TS} NOT NULL,
  last_login_at {TS},
  CHECK ((role = 'admin' AND tenant_id IS NULL) OR (role = 'staff' AND tenant_id IS NOT NULL))
);
`),
  },
  {
    // Postgres only: row-level security. The app sets app.tenant_id per transaction (Db.tenantTx);
    // FORCE applies the policy to the table owner too. Superusers / BYPASSRLS roles skip RLS, so the
    // app must connect as a normal role (docker-compose creates `receptionist_app`).
    id: '002_tenant_rls',
    sql: (d) => d !== 'pg' ? null : TENANT_TABLES.map((t) => `
ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${t} FORCE ROW LEVEL SECURITY;
CREATE POLICY ${t}_tenant_isolation ON ${t}
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));`).join('\n'),
  },
]

/** Applies pending migrations; returns the ids applied now. Safe to run from several instances at once on Postgres. */
export async function migrate(db: Db): Promise<string[]> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at ${db.dialect === 'pg' ? 'TIMESTAMPTZ' : 'TEXT'} NOT NULL)`)
  const applied: string[] = []
  for (const m of MIGRATIONS) {
    const done = await db.tx(async (q) => {
      if (db.dialect === 'pg') await q.query('SELECT pg_advisory_xact_lock(727274)')
      if ((await q.query('SELECT id FROM schema_migrations WHERE id = $1', [m.id])).length) return false
      const sql = m.sql(db.dialect)
      if (sql) for (const stmt of splitStatements(sql)) await q.query(stmt)
      await q.query('INSERT INTO schema_migrations (id, applied_at) VALUES ($1, $2)', [m.id, new Date().toISOString()])
      return true
    })
    if (done) applied.push(m.id)
  }
  return applied
}

function splitStatements(sql: string): string[] {
  return sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
}
