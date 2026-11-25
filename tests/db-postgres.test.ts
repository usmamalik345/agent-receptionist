/**
 * Postgres adapter + row-level security. Runs only when PG_TEST_URL points at a throwaway database
 * (connect as a NON-superuser role, e.g. the docker-compose `receptionist_app`): it drops and recreates the tables.
 *   PG_TEST_URL=postgres://receptionist_app:receptionist_app@localhost:5432/receptionist npm run test:pg
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SqlBookingStore } from '../server/db/bookingRepo.ts'
import { SqlCallLog } from '../server/db/callRepo.ts'
import { migrate } from '../server/db/migrations.ts'
import { connect, type Db } from '../server/db/sql.ts'
import { repoSuite } from './lib/repoSuite.ts'

const url = process.env.PG_TEST_URL
const skip = url ? false : 'PG_TEST_URL not set'

async function fresh(): Promise<Db> {
  const db = await connect(url!)
  await db.query('DROP TABLE IF EXISTS call_turns, calls, room_nights, bookings, users, schema_migrations CASCADE')
  await migrate(db)
  return db
}

if (url) {
  repoSuite('postgres', async () => {
    const db = await fresh()
    return { store: new SqlBookingStore(db), callLog: new SqlCallLog(db), close: () => db.close() }
  })
}

test('postgres RLS: a query that forgets the tenant filter still only sees its own tenant; cross-tenant writes are rejected', { skip }, async () => {
  const db = await fresh()
  try {
    const [{ su }] = await db.query<{ su: boolean }>("SELECT rolsuper AS su FROM pg_roles WHERE rolname = current_user")
    assert.equal(su, false, 'PG_TEST_URL must use a non-superuser role (superusers bypass RLS)')
    const add = (tenant: string, ref: string) => db.tenantTx(tenant, (q) => q.query("INSERT INTO bookings (tenant_id, ref, kind, name, phone, location, appt_date, appt_time, created_at) VALUES ($1, $2, 'appointment', 'A', '1', 'Main', '2026-11-26', '09:00', now())", [tenant, ref]))
    await add('tenant-a', 'D1')
    await add('tenant-b', 'D2')
    const seenByA = await db.tenantTx('tenant-a', (q) => q.query<{ ref: string }>('SELECT ref FROM bookings'))
    assert.deepEqual(seenByA.map((r) => r.ref), ['D1'])
    await assert.rejects(db.tenantTx('tenant-a', (q) => q.query("INSERT INTO bookings (tenant_id, ref, kind, name, phone, location, appt_date, appt_time, created_at) VALUES ('tenant-b', 'D9', 'appointment', 'A', '1', 'Main', '2026-11-27', '09:00', now())")), /row-level security/)
    const upd = await db.tenantTx('tenant-a', (q) => q.query("UPDATE bookings SET name = 'X' WHERE tenant_id = 'tenant-b' RETURNING ref"))
    assert.equal(upd.length, 0)
    assert.equal((await db.query('SELECT ref FROM bookings')).length, 0, 'no tenant set -> no rows')
  } finally {
    await db.close()
  }
})
