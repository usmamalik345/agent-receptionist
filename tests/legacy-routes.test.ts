/** Old public links (LinkedIn, website) must open the new console, with the right tenant. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { loadTenants } from '../server/platform/registry.ts'
import { LEGACY_BIZ_TO_TENANT, LEGACY_DEFAULT_TENANT, LEGACY_PATHS, legacyTarget } from '../src/legacyRoutes.ts'

const { tenants, errors } = loadTenants()
const known = (id: string) => tenants.has(id)
const go = (url: string) => { const u = new URL(url, 'https://x.test'); return legacyTarget(u.pathname, u.search, known) }

test('every old ?biz= slug maps to a valid tenant (from src/businesses/index.ts)', () => {
  assert.deepEqual(errors, [])
  const src = readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'businesses', 'index.ts'), 'utf8')
  const block = src.slice(src.indexOf('const BUSINESSES'), src.indexOf('}', src.indexOf('const BUSINESSES')))
  const slugs = [...block.matchAll(/^\s*'?([a-z0-9-]+)'?\s*:/gm)].map((m) => m[1])
  assert.deepEqual(slugs.sort(), Object.keys(LEGACY_BIZ_TO_TENANT).sort())
  for (const s of slugs) assert.ok(tenants.has(LEGACY_BIZ_TO_TENANT[s]), s)
  assert.match(src, new RegExp(`DEFAULT_BUSINESS_SLUG = '(\\w+)'`))
  assert.equal(LEGACY_BIZ_TO_TENANT[src.match(/DEFAULT_BUSINESS_SLUG = '([\w-]+)'/)![1]], LEGACY_DEFAULT_TENANT)
})

test('erth and mm-dental tenants carry real business data and stay labelled as demos', () => {
  const erth = tenants.get('erth-abu-dhabi')!
  assert.equal(erth.vertical, 'hotel')
  assert.equal(erth.currency, 'AED')
  assert.match(erth.locations[0].address, /Khor Al Maqta/)
  assert.ok(erth.hotel!.rooms.every((r) => r.ratePerNight === null), 'no invented room rates')
  const mm = tenants.get('mm-dental-care')!
  assert.equal(mm.locations.length, 2)
  assert.equal(mm.locations[0].phone, '0116 276 7760')
  for (const t of [erth, mm]) assert.ok(t.sample && /SAMPLE/.test(t.name) && t.source)
})

test('old links open the new console', () => {
  const cases: Array<[string, string | null]> = [
    ['/dashboard?biz=erth', '/app/erth-abu-dhabi/test'],
    ['/dashboard?biz=ERTH', '/app/erth-abu-dhabi/test'],
    ['/dashboard?biz=mm-dental', '/app/mm-dental-care/test'],
    ['/dashboard/?biz=erth', '/app/erth-abu-dhabi/test'],
    ['/dashboard', '/app/erth-abu-dhabi/test'],
    ['/dashboard?biz=erth&utm_source=linkedin', '/app/erth-abu-dhabi/test?utm_source=linkedin'],
    ['/dashboard?biz=brightsmile-dental', '/app/brightsmile-dental/test'],
    ['/dashboard?biz=nope', '/app'],
    ['/whatsapp-demo', '/app/erth-abu-dhabi/test'],
    ['/whatsapp-demo?biz=mm-dental', '/app/mm-dental-care/test'],
    ['/record-demo?biz=mm-dental', '/app/mm-dental-care/test'],
    ['/run-of-show', '/app/erth-abu-dhabi/test'],
    ['/go-live', '/app/erth-abu-dhabi/settings'],
    ['/pilot?biz=erth', '/app/erth-abu-dhabi/live'],
    ['/', '/app'],
    ['/?biz=erth', '/app/erth-abu-dhabi/test'],
    ['/?biz=mm-dental', '/app/mm-dental-care/test'],
    ['/app/erth-abu-dhabi/live', null],
    ['/legacy/dashboard', null],
  ]
  for (const [from, to] of cases) assert.equal(go(from), to, from)
})

test('every legacy path is routed and lands on a real tenant page', () => {
  for (const p of LEGACY_PATHS) {
    const to = go(`${p}?biz=erth`)!
    const m = to.match(/^\/app\/([^/?]+)\/(live|inbox|bookings|test|settings)/)
    assert.ok(m && tenants.has(m[1]), `${p} -> ${to}`)
  }
})
