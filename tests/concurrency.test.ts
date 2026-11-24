/** Simultaneous calls across tenants through the HTTP API (mock LLM): own-tenant answers, isolated sessions, no wrong-tenant or double bookings. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LruCache } from '../server/cache.ts'
import { Platform } from '../server/platform/orchestrator.ts'
import { loadTenants } from '../server/platform/registry.ts'
import { runLevel } from '../scripts/lib/concurrency.mts'

for (const n of [10, 50]) {
  test(`${n} concurrent multi-turn calls: every answer from its own tenant, no errors, store isolated`, async () => {
    const r = await runLevel(n, { timeoutMs: 10_000 })
    assert.deepEqual(r.failures, [])
    assert.equal(r.errors, 0)
    assert.equal(r.timeouts, 0)
    assert.equal(r.bookings, n)
    assert.equal(r.wrongTenantBookings, 0)
    assert.equal(r.doubleBooked, 0)
    if (n === 10) assert.deepEqual([r.hotel, r.dental], [5, 5])
  })
}

test('two callers race for the same dental slot: one books, the other is re-offered fresh slots in the same reply', async () => {
  const { tenants } = loadTenants()
  const p = new Platform({ tenants, traceSink: () => {}, cache: new LruCache(60_000), now: () => new Date('2026-11-25T09:00:00Z'), defaultRateLimitPerMinute: 10_000 })
  const id = 'abbey-dental-studio'
  const a = p.start(id).callId, b = p.start(id).callId
  for (const say of ['I need a check-up', 'the first one', 'Thursday', 'the first one']) { await p.turn(id, a, say); await p.turn(id, b, say) }
  await p.turn(id, a, 'Priya Shah'); await p.turn(id, b, 'Tom Reid')
  assert.match((await p.turn(id, a, '07700 900111')).text, /Shall I book it\?/)
  assert.match((await p.turn(id, b, '07700 900222')).text, /Shall I book it\?/)
  assert.ok((await p.turn(id, a, 'yes')).booking)
  const lost = await p.turn(id, b, 'yes')
  assert.equal(lost.booking, null)
  assert.match(lost.text, /just been taken/)
  assert.match(lost.text, /\?$/)
  assert.match((await p.turn(id, b, 'the first one')).text, /Shall I book it\?/)
  assert.ok((await p.turn(id, b, 'yes')).booking)
  const got = p.bookings(id)
  assert.equal(got.length, 2)
  assert.notEqual(`${got[0].date} ${got[0].time}`, `${got[1].date} ${got[1].time}`)
  assert.deepEqual(got.map((x) => x.name).sort(), ['Priya Shah', 'Tom Reid'])
})
