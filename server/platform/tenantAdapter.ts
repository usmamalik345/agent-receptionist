/** Adapter from a tenant config to the shape the shared retrieval/guard agents index (no Node built-ins). */
import type { BusinessConfig } from '../../src/config/businessTypes.ts'
import { money, type Tenant } from './tenant.ts'

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
    for (const r of t.hotel.rooms) {
      if (r.ratePerNight !== null) pricing.push({ item: `${r.type} (up to ${r.maxGuests} guests)`, price: `${money(t, r.ratePerNight)} per night` })
      else services.push({ name: `${r.type} (up to ${r.maxGuests} guests)`, priceNote: 'rate confirmed by reservations' })
    }
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
