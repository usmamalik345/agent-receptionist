/**
 * Writes the 20 SAMPLE tenants (10 hotels, 10 dental clinics) to config/tenants/.
 * All businesses are fictional. Phone numbers use Ofcom's drama ranges (UK) and the
 * 555-01xx fiction range (US), so none of them reach a real business.
 * Run: npx tsx scripts/gen-sample-tenants.mts  (deterministic; re-running gives the same files)
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { validateTenant, type Tenant } from '../server/platform/tenant.ts'

const ROOT = path.resolve(import.meta.dirname, '..')
const DIR = path.join(ROOT, 'config', 'tenants')
mkdirSync(DIR, { recursive: true })

const UK_AREAS = ['0113 496', '0114 496', '0115 496', '0116 496', '0117 496', '0118 496', '0121 496', '0131 496', '0141 496', '0151 496', '0161 496']
const ukPhone = (i: number, j = 0) => `${UK_AREAS[i % UK_AREAS.length]} 0${String(100 + i * 10 + j).padStart(3, '0')}`
const usPhone = (i: number) => `(212) 555-01${String(10 + i).padStart(2, '0')}`

const HOTEL_HOURS = { mon: '24 hours', tue: '24 hours', wed: '24 hours', thu: '24 hours', fri: '24 hours', sat: '24 hours', sun: '24 hours' }
const hotels: Array<[string, string, string, 'GBP' | 'USD', string, number]> = [
  ['harbour-view-hotel', 'Harbour View Hotel', 'Leeds', 'GBP', 'Europe/London', 1],
  ['the-old-mill-inn', 'The Old Mill Inn', 'Sheffield', 'GBP', 'Europe/London', 0.85],
  ['castlegate-suites', 'Castlegate Suites', 'Nottingham', 'GBP', 'Europe/London', 1.1],
  ['riverside-lodge', 'Riverside Lodge', 'Leicester', 'GBP', 'Europe/London', 0.8],
  ['clifton-grand', 'Clifton Grand Hotel', 'Bristol', 'GBP', 'Europe/London', 1.3],
  ['thames-court-hotel', 'Thames Court Hotel', 'Reading', 'GBP', 'Europe/London', 1.2],
  ['canal-quarter-hotel', 'Canal Quarter Hotel', 'Birmingham', 'GBP', 'Europe/London', 0.95],
  ['hudson-park-hotel', 'Hudson Park Hotel', 'New York', 'USD', 'America/New_York', 1.6],
  ['midtown-loft-hotel', 'Midtown Loft Hotel', 'New York', 'USD', 'America/New_York', 1.4],
  ['brooklyn-bridge-inn', 'Brooklyn Bridge Inn', 'New York', 'USD', 'America/New_York', 1.25],
]
const clinics: Array<[string, string, string, number]> = [
  ['brightsmile-dental', 'BrightSmile Dental', 'Leeds', 1],
  ['parkside-dental-care', 'Parkside Dental Care', 'Sheffield', 0.9],
  ['city-centre-dentists', 'City Centre Dentists', 'Nottingham', 1.15],
  ['oakwood-family-dental', 'Oakwood Family Dental', 'Leicester', 0.95],
  ['harbourside-dental', 'Harbourside Dental', 'Bristol', 1.2],
  ['abbey-dental-studio', 'Abbey Dental Studio', 'Reading', 1.1],
  ['jewellery-quarter-dental', 'Jewellery Quarter Dental', 'Birmingham', 1],
  ['old-town-dental', 'Old Town Dental', 'Edinburgh', 1.05],
  ['westend-smile-clinic', 'West End Smile Clinic', 'Glasgow', 0.9],
  ['mersey-dental-practice', 'Mersey Dental Practice', 'Liverpool', 0.85],
]
const VOICES_GB_F = ['Microsoft Sonia Online (Natural) - English (United Kingdom)', 'Microsoft Libby Online (Natural) - English (United Kingdom)', 'Google UK English Female', 'en-GB-SoniaNeural']
const VOICES_GB_M = ['Microsoft Ryan Online (Natural) - English (United Kingdom)', 'Microsoft Thomas Online (Natural) - English (United Kingdom)', 'Google UK English Male', 'en-GB-RyanNeural']
const VOICES_US_F = ['Microsoft Aria Online (Natural) - English (United States)', 'Microsoft Jenny Online (Natural) - English (United States)', 'Google US English', 'en-US-AriaNeural']
const AGENT_NAMES = ['Sophie', 'James', 'Emma', 'Oliver', 'Grace', 'Harry', 'Lucy', 'Ava', 'Mia', 'Noah']
const round = (n: number) => Math.round(n)

const out: Tenant[] = []
hotels.forEach(([id, name, city, currency, tz, k], i) => {
  const us = currency === 'USD'
  const phone = us ? usPhone(i) : ukPhone(i)
  out.push({
    id, vertical: 'hotel', name: `${name} (SAMPLE)`, sample: true, timezone: tz, currency, policyVersion: 'v1',
    rateLimitPerMinute: 120,
    voice: { agentName: AGENT_NAMES[i], locale: us ? 'en-US' : 'en-GB', preferredVoices: us ? VOICES_US_F : i % 2 ? VOICES_GB_M : VOICES_GB_F, rate: 1.0, pitch: 1.0, style: (['warm', 'calm', 'upbeat'] as const)[i % 3] },
    locations: [{ name, address: `${10 + i} ${['Quay Street', 'Mill Lane', 'Castle Gate', 'River Walk', 'Park Row', 'Thames Side', 'Canal Street', 'Hudson Street', 'West 44th Street', 'Water Street'][i]}, ${city}`, phone, hours: HOTEL_HOURS }],
    faqs: [
      { q: 'Is there parking?', a: i % 3 === 0 ? 'Yes, on-site parking is free for guests.' : i % 3 === 1 ? `Yes, parking is ${us ? '$' : '£'}${round(12 * k)} per night, booked at reception.` : 'There is no on-site parking; the nearest public car park is a five-minute walk.', keywords: 'parking park car garage' },
      { q: 'Do you allow pets?', a: i % 2 ? 'Yes, dogs are welcome in standard rooms for a small fee confirmed at check-in.' : 'Sorry, pets are not allowed, except assistance dogs.', keywords: 'pet pets dog dogs cat' },
      { q: 'Is breakfast included?', a: i % 2 ? 'Breakfast is included with every room.' : `Breakfast is ${us ? '$' : '£'}${round(15 * k)} per person per day.`, keywords: 'breakfast meal food dining restaurant' },
      { q: 'Do you have wifi?', a: 'Yes, free wifi is available throughout the hotel.', keywords: 'wifi internet wi-fi' },
      { q: 'How far is the station?', a: `The main ${city} station is about ${5 + (i % 4) * 5} minutes away by taxi.`, keywords: 'station train airport taxi transport directions' },
    ],
    hotel: {
      checkInTime: i % 2 ? '2pm' : '3pm', checkOutTime: i % 2 ? '11am' : '12pm',
      cancellationPolicy: i % 2 ? 'Free cancellation up to 48 hours before arrival; after that the first night is charged.' : 'Free cancellation up to 24 hours before arrival; after that the first night is charged.',
      rooms: [
        { type: 'Standard Double', ratePerNight: round(95 * k), maxGuests: 2, count: 3 },
        { type: 'Twin', ratePerNight: round(105 * k), maxGuests: 2, count: 2 },
        { type: 'Family Room', ratePerNight: round(150 * k), maxGuests: 4, count: 1 },
        { type: 'Suite', ratePerNight: round(220 * k), maxGuests: 3, count: 1 },
      ],
    },
  })
})
clinics.forEach(([id, name, city, k], i) => {
  const late = i % 2 === 0
  const twoSites = i % 3 === 0
  const loc = (n: number, label: string) => ({
    name: label, address: `${20 + i + n} ${['High Street', 'Park Road', 'Market Street', 'Oak Avenue', 'Harbour Road', 'Abbey Street', 'Vyse Street', 'Royal Mile', 'Sauchiehall Street', 'Dale Street'][i]}, ${city}`,
    phone: ukPhone(i, n + 5),
    hours: n === 0
      ? { mon: '8:30am–5pm', tue: late ? '8:30am–7pm' : '8:30am–5pm', wed: '8:30am–5pm', thu: late ? '9am–7pm' : '9am–5pm', fri: '9am–4pm', sat: i % 4 === 0 ? '9am–1pm' : 'closed', sun: 'closed' }
      : { mon: '9am–5pm', tue: '9am–5pm', wed: '9am–6pm', thu: '9am–5pm', fri: '9am–3pm', sat: 'closed', sun: 'closed' },
  })
  out.push({
    id, vertical: 'dental', name: `${name} (SAMPLE)`, sample: true, timezone: 'Europe/London', currency: 'GBP', policyVersion: 'v1',
    rateLimitPerMinute: 120,
    voice: { agentName: AGENT_NAMES[(i + 3) % 10], locale: 'en-GB', preferredVoices: i % 2 ? VOICES_GB_M : VOICES_GB_F, rate: 0.98, pitch: 1.0, style: (['calm', 'warm', 'upbeat'] as const)[i % 3] },
    locations: twoSites ? [loc(0, 'Central Practice'), loc(1, 'North Practice')] : [loc(0, `${city} Central`)],
    faqs: [
      { q: 'Are you taking new patients?', a: i % 4 === 3 ? 'We are taking new private patients; our NHS list is currently full.' : 'Yes, we are taking new NHS and private patients.', keywords: 'new patient patients register registration join nhs' },
      { q: 'Do you offer payment plans?', a: i % 2 ? 'Yes, treatment over £500 can be spread over 12 months interest-free.' : 'We take card and cash; payment is due on the day of treatment.', keywords: 'payment pay plan finance card cash monthly' },
      { q: 'Is there parking?', a: i % 2 ? 'There is free parking behind the practice.' : 'There is no private parking; the nearest pay-and-display is on the next street.', keywords: 'parking park car' },
      { q: 'Do you help nervous patients?', a: 'Yes, tell us when you book and we will give you a longer appointment and go at your pace.', keywords: 'nervous anxious scared afraid fear' },
      { q: 'Is the practice wheelchair accessible?', a: i % 3 === 1 ? 'We have one ground-floor surgery; please mention it when booking.' : 'Yes, there is step-free access and an accessible toilet.', keywords: 'wheelchair accessible access disabled step' },
    ],
    dental: {
      slotMinutes: 30,
      treatments: [
        { name: 'Check-up', price: round(55 * k), durationMin: 30 },
        { name: 'Scale and polish', price: round(65 * k), durationMin: 30 },
        { name: 'Filling', price: round(120 * k), durationMin: 60 },
        { name: 'Teeth whitening', price: round(300 * k), durationMin: 60 },
        { name: 'Emergency appointment', price: round(75 * k), durationMin: 30 },
        { name: 'Root canal', price: null, durationMin: 90 },
      ],
      emergency: {
        message: 'We keep same-day emergency slots for patients in pain; the team will confirm the time.',
        severeAdvice: 'If you have swelling that affects your breathing or swallowing, call 999 or go to A&E now.',
      },
    },
  })
})

for (const t of out) {
  const errs = validateTenant(t)
  if (errs.length) throw new Error(`${t.id}: ${errs.join('; ')}`)
  writeFileSync(path.join(DIR, `${t.id}.json`), JSON.stringify(t, null, 2) + '\n')
}
console.log(`wrote ${out.length} sample tenants to ${path.relative(ROOT, DIR)}`)
