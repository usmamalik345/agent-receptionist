/**
 * MM Dental Care engine + hotel-word leak checks.
 */
import { greet, processGuestMessage } from '../src/lib/stateMachine.ts'
import { emptyBooking } from '../src/lib/types.ts'
import { setActiveBusiness } from '../src/lib/businessRuntime.ts'
import { mmDentalBusiness } from '../src/businesses/mm-dental.ts'
import { erthBusiness } from '../src/businesses/erth.ts'
import { listBusinesses } from '../src/businesses/index.ts'

const HOTEL_LEAK =
  /\b(room|check-?in|guest|hotel|Marina|Desert\s*Palm|Opera|Booking\.com|Erth|Al\s*Rimal|villa|suite)\b/i

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

function leakScan(label: string, text: string) {
  const m = text.match(HOTEL_LEAK)
  assert(!m, `${label} leaked hotel word: ${m?.[0]} :: ${text.slice(0, 120)}`)
}

setActiveBusiness('mm-dental')

// --- Config surface ---
assert(mmDentalBusiness.slug === 'mm-dental', 'slug')
assert(mmDentalBusiness.industry === 'dental', 'industry')
assert(mmDentalBusiness.locations.length === 2, 'two practices')
assert(listBusinesses().some((b) => b.slug === 'erth'), 'erth listed')
assert(listBusinesses().some((b) => b.slug === 'mm-dental'), 'mm-dental listed')

const g = greet('en', false)
assert(/MM Dental Care/i.test(g.text), 'dental greeting')
leakScan('greeting', g.text)

// New patient booking end to end
let booking = emptyBooking('en')
let step = g.nextStep
let r = processGuestMessage({
  text: "Hi, I'd like to register as a new patient. Name Priya Shah, phone 07700900111, Uppingham Road, check-up next Tuesday morning",
  step,
  booking,
  language: 'en',
  afterHours: false,
  humanTakeover: false,
})
booking = { ...booking, ...r.bookingUpdates }
step = r.nextStep
console.log('NEW_PATIENT', step, booking.guestName, booking.patientType, booking.practice)
assert(booking.patientType === 'new' || /new/i.test(booking.patientType || ''), 'new patient type')
assert(/Priya/i.test(booking.guestName), 'name captured')
assert(/Uppingham/i.test(booking.practice || ''), 'practice captured')
leakScan('new patient reply', r.text)

if (step === 'confirm_summary') {
  r = processGuestMessage({
    text: 'Yes please',
    step,
    booking,
    language: 'en',
    afterHours: false,
    humanTakeover: false,
  })
  booking = { ...booking, ...r.bookingUpdates }
  assert(r.outcome === 'booked_inquiry' || r.outcome === 'after_hours_saved', 'new patient outcome')
  assert(!!r.createTicket, 'new patient ticket')
  leakScan('new patient confirm', r.text)
}

// Toothache in hours → same-day emergency + fee
booking = emptyBooking('en')
r = processGuestMessage({
  text: "I've got really bad toothache, can I be seen today? Name James Patel, phone 07700900123, new patient, Uppingham Road",
  step: 'await_intent',
  booking,
  language: 'en',
  afterHours: false,
  humanTakeover: false,
})
booking = { ...booking, ...r.bookingUpdates }
step = r.nextStep
console.log('EMERGENCY_IN', step, r.text.slice(0, 100))
assert(/£50|50 consultation/i.test(r.text) || /same-day emergency/i.test(r.text), 'emergency fee offered')
assert(booking.isEmergency === true, 'emergency flag')
leakScan('emergency in-hours', r.text)

if (step === 'confirm_summary') {
  r = processGuestMessage({
    text: 'Yes',
    step,
    booking,
    language: 'en',
    afterHours: false,
    humanTakeover: false,
  })
  assert(r.createTicket?.priority === 'urgent', 'urgent ticket in hours')
  assert(/urgent/i.test(r.text), 'urgent copy')
  leakScan('emergency confirm', r.text)
}

// After-hours emergency → URGENT callback
booking = emptyBooking('en')
r = processGuestMessage({
  text: "My filling fell out and it's killing me. Name Sarah Khan, phone 07700900456, existing patient, Upperton Road",
  step: 'await_intent',
  booking,
  language: 'en',
  afterHours: true,
  humanTakeover: false,
})
booking = { ...booking, ...r.bookingUpdates }
step = r.nextStep
console.log('EMERGENCY_AH', step, r.text.slice(0, 120))
assert(/closed|call you back|as soon as we open|urgent/i.test(r.text), 'after-hours messaging')
assert(booking.isEmergency === true, 'ah emergency flag')

if (step === 'confirm_summary') {
  r = processGuestMessage({
    text: 'Yes please',
    step,
    booking,
    language: 'en',
    afterHours: true,
    humanTakeover: false,
  })
  assert(r.createTicket?.priority === 'urgent', 'urgent after hours')
  assert(r.outcome === 'after_hours_saved' || r.outcome === 'booked_inquiry', 'ah outcome')
  leakScan('ah confirm', r.text)
}

// Crown price — no invented price, callback ticket
r = processGuestMessage({
  text: 'How much is a crown?',
  step: 'await_intent',
  booking: emptyBooking('en'),
  language: 'en',
  afterHours: false,
  humanTakeover: false,
})
console.log('CROWN', r.outcome, r.createTicket?.reason)
assert(r.outcome === 'callback_requested', 'crown callback')
assert(!!r.createTicket, 'crown ticket')
assert(!/£\d{2,}/.test(r.text) || /confirm/i.test(r.text), 'no invented crown price')
assert(/team to confirm|ask the team/i.test(r.text), 'defer to team')
leakScan('crown', r.text)

// Reschedule → callback
r = processGuestMessage({
  text: 'I need to move my appointment on Thursday. Name Alex Reed, phone 07700900999',
  step: 'await_intent',
  booking: emptyBooking('en'),
  language: 'en',
  afterHours: false,
  humanTakeover: false,
})
console.log('RESCHEDULE', r.outcome, r.text.slice(0, 100))
assert(r.outcome === 'callback_requested', 'reschedule callback')
assert(/call you to confirm your new time/i.test(r.text), 'reschedule caller copy')
assert(!/confirm your appointment shortly/i.test(r.text), 'reschedule no old confirm wording')
assert(!/No live diary|from this channel/i.test(r.text), 'reschedule no internal note spoken')
leakScan('reschedule', r.text)

// Saturday hours both practices
r = processGuestMessage({
  text: 'What time are you open on Saturday?',
  step: 'await_intent',
  booking: emptyBooking('en'),
  language: 'en',
  afterHours: false,
  humanTakeover: false,
})
console.log('SAT', r.text)
assert(/Uppingham/i.test(r.text) && /9am/.test(r.text) && /12pm/i.test(r.text), 'Uppingham sat hours')
assert(/Upperton/i.test(r.text), 'Upperton mentioned')
assert(/phone lines only/i.test(r.text), 'Upperton sat note')
assert(!/Saturday patients are seen|Saturday at Upperton/i.test(r.text), 'saturday not duplicated')
const satPhoneOnlyCount = (r.text.match(/phone lines only/gi) || []).length
assert(satPhoneOnlyCount === 1, 'saturday says phone lines only once')
leakScan('saturday', r.text)

// Membership from verified pricing
r = processGuestMessage({
  text: 'Do you do membership plans?',
  step: 'await_intent',
  booking: emptyBooking('en'),
  language: 'en',
  afterHours: false,
  humanTakeover: false,
})
assert(/£13\.50/i.test(r.text), 'membership price from config')
leakScan('membership', r.text)

// Nervous patient
r = processGuestMessage({
  text: "I'm really nervous about the dentist",
  step: 'await_intent',
  booking: emptyBooking('en'),
  language: 'en',
  afterHours: false,
  humanTakeover: false,
})
assert(/nervous/i.test(r.text), 'nervous reassurance')
leakScan('nervous', r.text)

// Config strings themselves must not leak hotel words (except erth business)
for (const loc of mmDentalBusiness.locations) {
  leakScan(`loc ${loc.name}`, `${loc.name} ${loc.address} ${loc.notes || ''}`)
}
for (const faq of mmDentalBusiness.faqs) {
  leakScan(`faq ${faq.q}`, `${faq.q} ${faq.a}`)
}
for (const chip of mmDentalBusiness.demoChips.en) {
  leakScan(`chip ${chip.label}`, `${chip.label} ${chip.text}`)
}
leakScan('greeting cfg', mmDentalBusiness.greetings.en)
leakScan('after hours cfg', mmDentalBusiness.afterHoursMessage)

// Erth still resolves as hotel
setActiveBusiness('erth')
const eg = greet('en', false)
assert(/Erth/i.test(eg.text), 'erth still greets as hotel')
assert(erthBusiness.industry === 'hotel', 'erth hotel industry')

console.log('DENTAL_SMOKE_PASS')
