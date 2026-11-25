/** Repository layer: memory and SQLite stores pass the same conformance suite; migrations; DB-level constraints. Postgres: tests/db-postgres.test.ts */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SqlBookingStore } from '../server/db/bookingRepo.ts'
import { SqlCallLog } from '../server/db/callRepo.ts'
import { MIGRATIONS, migrate } from '../server/db/migrations.ts'
import { connect, redactUrl, UniqueViolation } from '../server/db/sql.ts'
import { MemoryCallLog } from '../server/platform/callLog.ts'
import { MemoryBookingStore } from '../server/platform/store.ts'
import { repoSuite } from './lib/repoSuite.ts'

repoSuite('memory', async () => ({ store: new MemoryBookingStore(), callLog: new MemoryCallLog() }))
repoSuite('sqlite', async () => {
  const db = await connect('sqlite::memory:')
  await migrate(db)
  return { store: new SqlBookingStore(db), callLog: new SqlCallLog(db), close: () => db.close() }
})

test('migrations: applied once, recorded, idempotent on re-run', async () => {
  const db = await connect('sqlite::memory:')
  try {
    assert.deepEqual(await migrate(db), ['001_init', '002_tenant_rls'])
    assert.deepEqual(await migrate(db), [])
    const rows = await db.query<{ id: string }>('SELECT id FROM schema_migrations ORDER BY id')
    assert.deepEqual(rows.map((r) => r.id), MIGRATIONS.map((m) => m.id))
  } finally {
    await db.close()
  }
})

test('schema constraints hold even if the app is bypassed: double slot, oversold unit, bad role, kind checks', async () => {
  const db = await connect('sqlite::memory:')
  try {
    await migrate(db)
    const ins = (ref: string, time = '09:00', tenant = 't1') =>
      db.query("INSERT INTO bookings (tenant_id, ref, kind, name, phone, location, appt_date, appt_time, created_at) VALUES ($1, $2, 'appointment', 'A', '1', 'Main', '2026-11-26', $3, '2026-11-25T00:00:00Z')", [tenant, ref, time])
    await ins('D1000')
    await assert.rejects(ins('D1001'), (e) => e instanceof UniqueViolation && /appt_time/.test(e.constraint))
    await assert.rejects(ins('D1000', '10:00'), UniqueViolation, 'ref is unique per tenant')
    await ins('D1000', '09:00', 't2') // same ref + slot in another tenant is fine
    await db.query("INSERT INTO bookings (tenant_id, ref, kind, name, phone, room_type, check_in, check_out, created_at) VALUES ('t1', 'H1', 'room', 'B', '2', 'Double', '2026-12-01', '2026-12-02', '2026-11-25T00:00:00Z')")
    await db.query("INSERT INTO room_nights (tenant_id, room_type, night, unit, booking_ref) VALUES ('t1', 'Double', '2026-12-01', 1, 'H1')")
    await assert.rejects(db.query("INSERT INTO room_nights (tenant_id, room_type, night, unit, booking_ref) VALUES ('t1', 'Double', '2026-12-01', 1, 'H1')"), UniqueViolation)
    await assert.rejects(db.query("INSERT INTO bookings (tenant_id, ref, kind, name, phone, room_type, check_in, check_out, created_at) VALUES ('t1', 'H2', 'room', 'B', '2', 'Double', '2026-12-02', '2026-12-01', 'x')"), /CHECK/i)
    await assert.rejects(db.query("INSERT INTO users (id, email, password_hash, role, tenant_id, created_at) VALUES ('u1', 'a@b.co', 'x', 'staff', NULL, 'x')"), /CHECK/i)
    await assert.rejects(db.query("INSERT INTO users (id, email, password_hash, role, tenant_id, created_at) VALUES ('u2', 'b@b.co', 'x', 'admin', 't1', 'x')"), /CHECK/i)
  } finally {
    await db.close()
  }
})

test('connect: rejects unknown URLs; redactUrl hides the password', async () => {
  await assert.rejects(connect('mysql://x'), /postgres:\/\/ or sqlite:/)
  assert.equal(redactUrl('postgres://app:s3cret@db:5432/x'), 'postgres://app:***@db:5432/x')
})
