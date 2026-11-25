/**
 * Concurrency harness: N simultaneous multi-turn calls through the real HTTP API
 * (express + mountPlatformRoutes + Platform, mock LLM). Every turn is checked against the
 * caller's OWN tenant config (hours, prices, booking) and against every other tenant
 * (no other brand / phone in any reply). At the end the booking store must hold exactly
 * the bookings each tenant's callers confirmed, under their own names.
 */
import type { AddressInfo } from 'node:net'
import express from 'express'
import { LruCache } from '../../server/cache.ts'
import { createMockClient } from '../../server/llm.ts'
import { silentLogger } from '../../server/platform/logger.ts'
import { mountPlatformRoutes } from '../../server/platform/http.ts'
import { Platform } from '../../server/platform/orchestrator.ts'
import { loadTenants } from '../../server/platform/registry.ts'
import { money, type Tenant } from '../../server/platform/tenant.ts'

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const brand = (t: Tenant) => t.name.replace(/\s*\(SAMPLE\)\s*/i, '')
const speak = (h: string) => h.replace(/\s*[–-]\s*/g, ' to ')
const FIRST = ['Priya', 'Maya', 'Tom', 'Aisha', 'Leo', 'Nadia', 'Omar', 'Sara', 'Ben', 'Hana']
const LAST = ['Shah', 'Khan', 'Reid', 'Patel', 'Hughes', 'Malik', 'Evans', 'Ali', 'Clarke', 'Brooks']

export interface LevelResult {
  level: number; calls: number; turns: number; tenants: number; hotel: number; dental: number
  wallMs: number; throughputTurnsPerSec: number; p50: number; p95: number; max: number
  errors: number; timeouts: number; failures: string[]; bookings: number; wrongTenantBookings: number; slotConflicts: number; doubleBooked: number
}

type Turn = { say: string; must?: RegExp[]; booked?: boolean }

function script(t: Tenant, name: string, phone: string): Turn[] {
  const loc = t.locations[0]
  if (t.dental) {
    const f = t.dental.treatments.find((x) => x.name === 'Filling') ?? t.dental.treatments.find((x) => x.price !== null)!
    return [
      { say: 'What time do you close on Friday?', must: [new RegExp(esc(speak(loc.hours.fri)))] },
      { say: `How much is ${/^[aeiou]/i.test(f.name) ? 'an' : 'a'} ${f.name.toLowerCase()}?`, must: [new RegExp(esc(money(t, f.price!)))] },
      { say: 'I need a check-up' }, { say: 'the first one' }, { say: 'Thursday' }, { say: 'the first one' },
      { say: name }, { say: phone, must: [/Shall I book it\?/, new RegExp(esc(name.split(' ')[0]))] },
      { say: 'yes', must: [/booked/], booked: true },
    ]
  }
  return [
    { say: 'Is reception open on Sunday?', must: [new RegExp(esc(speak(loc.hours.sun)))] },
    { say: 'How much are your rooms?', must: [new RegExp(esc(t.hotel!.rooms[0].ratePerNight === null ? t.hotel!.rooms[0].type : money(t, t.hotel!.rooms[0].ratePerNight)))] },
    { say: 'I want to book a room' }, { say: 'from 27 November for 2 nights' }, { say: '2 adults' }, { say: 'the first one' },
    { say: name }, { say: phone, must: [/Shall I book it\?/, new RegExp(esc(name.split(' ')[0]))] },
    { say: 'yes', must: [/booked/], booked: true },
  ]
}

/** Pick which tenants get the N calls: level 10 = 5 dental + 5 hotel, otherwise round-robin over all 20. */
export function assign(all: Tenant[], n: number): Tenant[] {
  const hotels = all.filter((t) => t.vertical === 'hotel'), dental = all.filter((t) => t.vertical === 'dental')
  if (n === 10) return [...dental.slice(0, 5), ...hotels.slice(0, 5)]
  const mixed: Tenant[] = []
  for (let i = 0; mixed.length < all.length; i++) { if (hotels[i]) mixed.push(hotels[i]); if (dental[i]) mixed.push(dental[i]) }
  return Array.from({ length: n }, (_, i) => mixed[i % mixed.length])
}

const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] : 0 }

export async function runLevel(level: number, opts: { timeoutMs?: number; seed?: number } = {}): Promise<LevelResult> {
  const { tenants } = loadTenants()
  const all = [...tenants.values()].sort((a, b) => a.id.localeCompare(b.id))
  const platform = new Platform({ tenants, llm: createMockClient(), cache: new LruCache(60_000), traceSink: () => {}, now: () => new Date('2026-11-25T09:00:00Z'), defaultRateLimitPerMinute: 10_000 })
  const app = express(); app.use(express.json())
  mountPlatformRoutes(app, platform, { logger: silentLogger, tenantErrors: [] })
  const srv = app.listen(0)
  await new Promise((r) => srv.once('listening', r))
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`
  const timeoutMs = opts.timeoutMs ?? 5000
  let seed = opts.seed ?? 7
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)

  const others = new Map(all.map((t) => [t.id, all.filter((o) => o.id !== t.id && brand(o) !== brand(t))]))
  const lat: number[] = []; const failures: string[] = []; let errors = 0, timeouts = 0, turns = 0, conflicts = 0
  const expected = new Map<string, Set<string>>() // tenant -> caller names that confirmed
  const picked = assign(all, level)

  const post = async (u: string, body?: unknown) => {
    const t0 = performance.now()
    const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const r = await fetch(base + u, { method: 'POST', signal: ctrl.signal, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
      const j = await r.json(); lat.push(performance.now() - t0)
      if (!r.ok || !j.ok) { errors++; throw new Error(`HTTP ${r.status} ${j.error}`) }
      return j
    } catch (e) { if ((e as Error).name === 'AbortError') timeouts++; throw e } finally { clearTimeout(to) }
  }

  const t0 = performance.now()
  await Promise.all(picked.map(async (t, i) => {
    const name = `${FIRST[i % 10]} ${LAST[Math.floor(i / 10) % 10]}`
    const phone = `07700 9${String(10000 + i).slice(1)}`
    const tag = `${t.id}#${i}`
    try {
      await new Promise((r) => setTimeout(r, rnd() * 20))
      const s = await post(`/api/v1/tenants/${t.id}/calls`)
      if (!s.greeting.includes(brand(t))) failures.push(`${tag}: greeting not for own tenant`)
      for (const turn of script(t, name, phone)) {
        await new Promise((r) => setTimeout(r, rnd() * 15)) // interleave callers
        let r = await post(`/api/v1/tenants/${t.id}/calls/${s.callId}/turns`, { text: turn.say }); turns++
        // Two callers confirmed the same slot at once: the loser is re-offered; take the first option and confirm again.
        for (let retry = 0; turn.booked && !r.booking && /just been taken/.test(r.text) && retry < 3; retry++) {
          conflicts++
          if (!/Shall I book it\?/.test(r.text)) { r = await post(`/api/v1/tenants/${t.id}/calls/${s.callId}/turns`, { text: 'the first one' }); turns++ }
          if (/Shall I book it\?/.test(r.text)) { r = await post(`/api/v1/tenants/${t.id}/calls/${s.callId}/turns`, { text: 'yes' }); turns++ }
        }
        for (const m of turn.must ?? []) if (!m.test(r.text)) failures.push(`${tag} "${turn.say}": missing ${m} in "${r.text}"`)
        for (const o of others.get(t.id)!) if (r.text.includes(brand(o)) || r.text.includes(o.locations[0].phone)) failures.push(`${tag}: reply mentions other tenant ${o.id}`)
        if (turn.booked) {
          if (!r.booking) failures.push(`${tag}: no booking on confirm`)
          else { if (!expected.has(t.id)) expected.set(t.id, new Set()); expected.get(t.id)!.add(`${name}|${phone}`) }
        } else if (r.booking) failures.push(`${tag} "${turn.say}": booking written before confirmation`)
      }
    } catch (e) { failures.push(`${tag}: ${(e as Error).message}`) }
  }))
  const wallMs = performance.now() - t0
  srv.close()

  // store audit: each tenant holds exactly its own callers' bookings
  let bookings = 0, wrong = 0, double = 0
  for (const t of all) {
    const got = platform.bookings(t.id)
    bookings += got.length
    const want = expected.get(t.id) ?? new Set<string>()
    for (const b of got) if (b.tenantId !== t.id || !want.has(`${b.name}|${b.phone.replace(/\D/g, '').replace(/^(\d{5})(\d+)$/, '$1 $2')}`) && !want.has(`${b.name}|${b.phone}`)) { wrong++; failures.push(`store ${t.id}: unexpected booking ${b.name} ${b.phone}`) }
    if (got.length !== want.size) failures.push(`store ${t.id}: ${got.length} bookings, expected ${want.size}`)
    const slots = got.filter((b) => b.kind === 'appointment').map((b) => `${b.location}|${b.date}|${b.time}`)
    double += slots.length - new Set(slots).size
  }
  return {
    level, calls: picked.length, turns, tenants: new Set(picked.map((t) => t.id)).size,
    hotel: picked.filter((t) => t.vertical === 'hotel').length, dental: picked.filter((t) => t.vertical === 'dental').length,
    wallMs, throughputTurnsPerSec: turns / (wallMs / 1000), p50: pct(lat, 0.5), p95: pct(lat, 0.95), max: Math.max(0, ...lat),
    errors, timeouts, failures: double ? [...failures, `${double} appointment slots double-booked`] : failures, bookings, wrongTenantBookings: wrong, slotConflicts: conflicts, doubleBooked: double,
  }
}
