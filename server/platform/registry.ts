/**
 * Tenant registry: loads every config/tenants/*.json (TENANTS_DIR), validates it and
 * keeps it by id. A file that fails validation is reported and NOT loaded (fail closed).
 * `toBusinessConfig` adapts a tenant to the shape the shared retrieval agent indexes.
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { BusinessConfig } from '../../src/config/businessTypes.ts'
import { money, validateTenant, type Tenant } from './tenant.ts'

export const DEFAULT_TENANTS_DIR = path.resolve(import.meta.dirname, '..', '..', 'config', 'tenants')

export interface LoadResult {
  tenants: Map<string, Tenant>
  errors: Array<{ file: string; problems: string[] }>
}

export function loadTenants(dir = process.env.TENANTS_DIR || DEFAULT_TENANTS_DIR): LoadResult {
  const tenants = new Map<string, Tenant>()
  const errors: LoadResult['errors'] = []
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    let json: unknown
    try {
      json = JSON.parse(readFileSync(path.join(dir, f), 'utf8'))
    } catch (e) {
      errors.push({ file: f, problems: [`invalid JSON: ${e instanceof Error ? e.message : e}`] })
      continue
    }
    const problems = validateTenant(json)
    const t = json as Tenant
    if (!problems.length && tenants.has(t.id)) problems.push(`duplicate id ${t.id}`)
    if (!problems.length && `${t.id}.json` !== f) problems.push(`file name must be ${t.id}.json`)
    if (problems.length) errors.push({ file: f, problems })
    else tenants.set(t.id, Object.freeze(t))
  }
  return { tenants, errors }
}

const kw = (s?: string) => (s ? new RegExp(`\\b(${s.trim().split(/\s+/).map((w) => w.replace(/[^a-z0-9-]/gi, '')).join('|')})\\b`, 'i') : undefined)

/** Adapter to the shared retrieval/guard shape. Only config facts; nothing invented. */
export function toBusinessConfig(t: Tenant): BusinessConfig {
  const faqs = t.faqs.map((f) => ({ q: f.q, a: f.a, keywords: kw(f.keywords) }))
  const pricing: Array<{ item: string; price: string }> = []
  const services: Array<{ name: string; priceNote?: string }> = []
  if (t.hotel) {
    faqs.push(
      { q: 'What time is check-in and check-out?', a: `Check-in is from ${t.hotel.checkInTime} and check-out is by ${t.hotel.checkOutTime}.`, keywords: kw('check-in checkin check-out checkout arrive arrival leave departure') },
      { q: 'What is the cancellation policy?', a: t.hotel.cancellationPolicy, keywords: kw('cancel cancellation refund policy') },
    )
    for (const r of t.hotel.rooms) pricing.push({ item: `${r.type} (up to ${r.maxGuests} guests)`, price: `${money(t, r.ratePerNight)} per night` })
  }
  if (t.dental) {
    for (const tr of t.dental.treatments) {
      if (tr.price !== null) pricing.push({ item: tr.name, price: `from ${money(t, tr.price)}` })
      else services.push({ name: tr.name, priceNote: 'price after assessment' })
    }
  }
  return {
    slug: t.id,
    industry: t.vertical,
    name: t.name,
    greetingName: t.name.replace(/\s*\(SAMPLE\)\s*/i, ''),
    locale: t.voice.locale,
    languages: ['en'],
    timezone: t.timezone,
    locations: t.locations,
    services,
    pricing,
    faqs,
    emergency: t.dental ? { enabled: true, message: t.dental.emergency.message, severeAdvice: t.dental.emergency.severeAdvice } : { enabled: false, message: '' },
    escalationRules: { humanPhrases: [], modifyAsCallback: true, inventPrices: false },
  } as unknown as BusinessConfig
}
