/**
 * Tenant config (one JSON file per business under config/tenants/). Onboarding a new
 * hotel or clinic = add a validated JSON file; no code change. Sample tenants are
 * fictional and carry `sample: true` + "SAMPLE" in their name.
 */
import type { DayKey } from '../agents/hoursTool.ts'

export type Vertical = 'hotel' | 'dental'

export interface TenantLocation {
  name: string
  address: string
  phone: string
  hours: Record<DayKey, string>
}
export interface VoicePersona {
  /** Name the agent uses on the call */
  agentName: string
  /** BCP-47, e.g. en-GB */
  locale: string
  /** Preferred voices, best first (browser picks the first available; server TTS uses the first) */
  preferredVoices: string[]
  rate: number
  pitch: number
  /** warm | calm | upbeat - wording style of acknowledgements */
  style: 'warm' | 'calm' | 'upbeat'
}
export interface HotelConfig {
  checkInTime: string
  checkOutTime: string
  cancellationPolicy: string
  /** ratePerNight null = not published; the rate is confirmed by reservations (never invented) */
  rooms: Array<{ type: string; ratePerNight: number | null; maxGuests: number; count: number }>
}
export interface DentalConfig {
  slotMinutes: number
  treatments: Array<{ name: string; price: number | null; durationMin: number }>
  emergency: { message: string; severeAdvice: string }
}
export interface Tenant {
  id: string
  vertical: Vertical
  name: string
  sample: boolean
  /** Where the facts come from (demo tenants built from a business's public site) */
  source?: string
  timezone: string
  currency: 'GBP' | 'USD' | 'AED' | 'EUR' | 'PKR'
  policyVersion: string
  voice: VoicePersona
  locations: TenantLocation[]
  faqs: Array<{ q: string; a: string; keywords?: string }>
  rateLimitPerMinute?: number
  hotel?: HotelConfig
  dental?: DentalConfig
}

const DAYS: DayKey[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Returns a list of problems; empty = valid. Strict on purpose: a bad tenant file must not load. */
export function validateTenant(t: unknown): string[] {
  const e: string[] = []
  if (!t || typeof t !== 'object') return ['not an object']
  const x = t as Record<string, unknown>
  if (!isStr(x.id) || !/^[a-z0-9][a-z0-9-]{1,48}$/.test(x.id)) e.push('id: lowercase slug required')
  if (x.vertical !== 'hotel' && x.vertical !== 'dental') e.push('vertical: hotel | dental')
  if (!isStr(x.name)) e.push('name required')
  if (typeof x.sample !== 'boolean') e.push('sample: boolean required')
  if (x.sample === true && isStr(x.name) && !/sample/i.test(x.name)) e.push('sample tenants must say SAMPLE in the name')
  if (!isStr(x.timezone)) e.push('timezone required')
  if (!['GBP', 'USD', 'AED', 'EUR', 'PKR'].includes(String(x.currency))) e.push('currency invalid')
  if (!isStr(x.policyVersion)) e.push('policyVersion required')
  const v = x.voice as Record<string, unknown> | undefined
  if (!v || !isStr(v.agentName) || !isStr(v.locale) || !Array.isArray(v.preferredVoices) || !isNum(v.rate) || !isNum(v.pitch)) e.push('voice: agentName, locale, preferredVoices[], rate, pitch')
  else if ((v.rate as number) < 0.5 || (v.rate as number) > 1.5 || (v.pitch as number) < 0.5 || (v.pitch as number) > 1.5) e.push('voice: rate/pitch 0.5-1.5')
  if (!Array.isArray(x.locations) || x.locations.length === 0) e.push('locations: at least one')
  else
    (x.locations as Array<Record<string, unknown>>).forEach((l, i) => {
      if (!isStr(l.name) || !isStr(l.address) || !isStr(l.phone)) e.push(`locations[${i}]: name, address, phone`)
      const h = l.hours as Record<string, unknown> | undefined
      if (!h || DAYS.some((d) => !isStr(h[d]))) e.push(`locations[${i}].hours: all 7 days`)
    })
  if (!Array.isArray(x.faqs)) e.push('faqs: array')
  else (x.faqs as Array<Record<string, unknown>>).forEach((f, i) => { if (!isStr(f.q) || !isStr(f.a)) e.push(`faqs[${i}]: q, a`) })
  if (x.rateLimitPerMinute !== undefined && (!isNum(x.rateLimitPerMinute) || (x.rateLimitPerMinute as number) < 1)) e.push('rateLimitPerMinute >= 1')
  if (x.vertical === 'hotel') {
    const h = x.hotel as Record<string, unknown> | undefined
    if (!h || !isStr(h.checkInTime) || !isStr(h.checkOutTime) || !isStr(h.cancellationPolicy) || !Array.isArray(h.rooms) || !h.rooms.length) e.push('hotel: checkInTime, checkOutTime, cancellationPolicy, rooms[]')
    else (h.rooms as Array<Record<string, unknown>>).forEach((r, i) => { if (!isStr(r.type) || !(r.ratePerNight === null || isNum(r.ratePerNight)) || !isNum(r.maxGuests) || !isNum(r.count)) e.push(`hotel.rooms[${i}]: type, ratePerNight, maxGuests, count`) })
    if (x.dental) e.push('hotel tenant must not have a dental block')
  }
  if (x.vertical === 'dental') {
    const d = x.dental as Record<string, unknown> | undefined
    if (!d || !isNum(d.slotMinutes) || !Array.isArray(d.treatments) || !d.treatments.length || !d.emergency) e.push('dental: slotMinutes, treatments[], emergency')
    else (d.treatments as Array<Record<string, unknown>>).forEach((r, i) => { if (!isStr(r.name) || !(r.price === null || isNum(r.price)) || !isNum(r.durationMin)) e.push(`dental.treatments[${i}]: name, price|null, durationMin`) })
    if (x.hotel) e.push('dental tenant must not have a hotel block')
  }
  return e
}

export const CURRENCY_WORD: Record<Tenant['currency'], string> = { GBP: '£', USD: '$', AED: 'AED ', EUR: '€', PKR: 'Rs ' }
export const money = (t: Tenant, n: number) => `${CURRENCY_WORD[t.currency]}${Number.isInteger(n) ? n : n.toFixed(2)}`
