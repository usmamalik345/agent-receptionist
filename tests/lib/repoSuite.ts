/** Conformance suite for every BookingStore / CallLog implementation (memory, SQLite, Postgres). */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LruCache } from '../../server/cache.ts'
import type { CallLog } from '../../server/platform/callLog.ts'
import { Platform } from '../../server/platform/orchestrator.ts'
import { loadTenants } from '../../server/platform/registry.ts'
import type { BookingStore } from '../../server/platform/store.ts'

export const NOW = () => new Date('2026-11-25T09:00:00Z') // Wednesday
export const { tenants } = loadTenants()
const clinic = tenants.get('brightsmile-dental')!
const otherClinic = tenants.get('mm-dental-care')!
const hotel = tenants.get('harbour-view-hotel')!

export function repoSuite(name: string, make: () => Promise<{ store: BookingStore; callLog: CallLog; close?: () => Promise<void> }>) {
  test(`${name}: appointment create/list round-trips; a taken slot leaves availability; same slot twice is refused`, async () => {
    const { store, close } = await make()
    try {
      const loc = clinic.locations[0].name
      const q = { date: '2026-11-26', location: loc, durationMin: 30 }
      const before = await store.appointmentSlots(clinic, q)
      assert.ok(before.length > 2)
      const b = await store.createAppointment(clinic, { date: q.date, time: before[0], treatment: clinic.dental!.treatments[0].name, location: loc, name: 'Priya Shah', phone: '07700900123', callId: 'call-1' })
      assert.match(b.ref, /^D\d{4}$/)
      assert.equal(b.tenantId, clinic.id)
      assert.equal(b.kind, 'appointment')
      assert.ok(!(await store.appointmentSlots(clinic, q)).includes(before[0]))
      await assert.rejects(store.createAppointment(clinic, { date: q.date, time: before[0], treatment: clinic.dental!.treatments[0].name, location: loc, name: 'Tom Reid', phone: '07700900222' }), /slot_unavailable/)
      const rows = await store.list(clinic.id)
      assert.equal(rows.length, 1)
      assert.deepEqual({ ref: rows[0].ref, name: rows[0].name, date: rows[0].date, time: rows[0].time, location: rows[0].location }, { ref: b.ref, name: 'Priya Shah', date: q.date, time: before[0], location: loc })
    } finally {
      await close?.()
    }
  })

  test(`${name}: 10 parallel callers race for one slot -> exactly one booking`, async () => {
    const { store, close } = await make()
    try {
      const loc = clinic.locations[0].name
      const [slot] = await store.appointmentSlots(clinic, { date: '2026-11-27', location: loc, durationMin: 30 })
      const r = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => store.createAppointment(clinic, { date: '2026-11-27', time: slot, treatment: clinic.dental!.treatments[0].name, location: loc, name: `Caller ${i}`, phone: '07700900123' })))
      assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1)
      for (const x of r) if (x.status === 'rejected') assert.match(String(x.reason), /slot_unavailable/)
      assert.equal((await store.list(clinic.id)).length, 1)
    } finally {
      await close?.()
    }
  })

  test(`${name}: rooms never oversold, even with parallel bookings; price stored`, async () => {
    const { store, close } = await make()
    try {
      const stay = { checkIn: '2026-12-01', checkOut: '2026-12-03', guests: 2 }
      const opts = await store.roomOptions(hotel, stay)
      const pick = opts[0]
      assert.ok(pick && pick.left >= 1)
      const n = pick.left + 3
      const r = await Promise.allSettled(Array.from({ length: n }, (_, i) => store.createRoomBooking(hotel, { ...stay, roomType: pick.type, name: `Guest ${i}`, phone: '07700900456' })))
      const ok = r.filter((x) => x.status === 'fulfilled')
      assert.equal(ok.length, pick.left, 'sold exactly the rooms that were left')
      assert.equal((ok[0] as PromiseFulfilledResult<{ totalPrice?: number }>).value.totalPrice, pick.total ?? undefined)
      assert.ok(!(await store.roomOptions(hotel, stay)).some((o) => o.type === pick.type), 'type now sold out for the stay')
      // a stay that only overlaps the last night is also blocked; one starting at check-out is fine
      assert.ok(!(await store.roomOptions(hotel, { checkIn: '2026-12-02', checkOut: '2026-12-04', guests: 2 })).some((o) => o.type === pick.type))
      assert.ok((await store.roomOptions(hotel, { checkIn: '2026-12-03', checkOut: '2026-12-04', guests: 2 })).some((o) => o.type === pick.type))
    } finally {
      await close?.()
    }
  })

  test(`${name}: tenant isolation - one tenant's bookings and calls are invisible to another`, async () => {
    const { store, callLog, close } = await make()
    try {
      const loc = clinic.locations[0].name
      const [slot] = await store.appointmentSlots(clinic, { date: '2026-11-26', location: loc, durationMin: 30 })
      await store.createAppointment(clinic, { date: '2026-11-26', time: slot, treatment: clinic.dental!.treatments[0].name, location: loc, name: 'Priya Shah', phone: '07700900123' })
      assert.equal((await store.list(otherClinic.id)).length, 0)
      assert.equal((await store.list(hotel.id)).length, 0)
      await callLog.callStarted(clinic.id, 'call-aaaa-1', NOW().toISOString())
      assert.equal((await callLog.listCalls(otherClinic.id)).length, 0)
      assert.equal((await callLog.listTurns(otherClinic.id, 'call-aaaa-1')).length, 0)
      // a turn written under the wrong tenant does not attach to the other tenant's call
      await callLog.turnRecorded({ tenantId: otherClinic.id, callId: 'call-aaaa-1', turn: 1, traceId: 't', agent: 'faq', intent: 'hours', tools: [], escalated: false, guardBlocked: false, bookingRef: null, latencyMs: 3, replyChars: 10, at: NOW().toISOString() })
      assert.equal((await callLog.listTurns(clinic.id, 'call-aaaa-1')).length, 0)
      assert.equal((await callLog.listCalls(clinic.id))[0].turns, 0)
    } finally {
      await close?.()
    }
  })

  test(`${name}: full call through the orchestrator persists booking + call + turns (no caller words)`, async () => {
    const { store, callLog, close } = await make()
    try {
      const p = new Platform({ tenants, traceSink: () => {}, now: NOW, cache: new LruCache(60_000), store, callLog })
      const { callId } = p.start(clinic.id)
      let last
      for (const line of ['I need a check-up', 'the first one', 'Thursday', 'the first one', 'Priya Shah', '07700 900123', 'yes']) last = await p.turn(clinic.id, callId, line)
      assert.ok(last?.booking, 'booked')
      p.end(clinic.id, callId)
      await p.flush()
      const [b] = await p.bookings(clinic.id)
      assert.equal(b.callId, callId)
      const calls = await p.calls(clinic.id)
      assert.equal(calls.length, 1)
      assert.equal(calls[0].outcome, 'booked')
      assert.equal(calls[0].bookingRef, b.ref)
      assert.equal(calls[0].turns, 7)
      assert.ok(calls[0].endedAt)
      const turns = await p.callTurns(clinic.id, callId)
      assert.deepEqual(turns.map((t) => t.turn), [1, 2, 3, 4, 5, 6, 7])
      assert.ok(turns.at(-1)!.tools.some((t) => t.startsWith('book_appointment:ok')))
      assert.ok(!JSON.stringify(turns).includes('Priya'), 'caller words/name are not stored in the call log')
      assert.equal((await p.calls(otherClinic.id)).length, 0)
    } finally {
      await close?.()
    }
  })
}
