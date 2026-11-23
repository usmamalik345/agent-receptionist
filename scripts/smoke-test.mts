/**
 * Hotel smoke tests — must keep passing for ?biz=erth (default).
 */
import { greet, processGuestMessage } from '../src/lib/stateMachine.ts'
import { emptyBooking } from '../src/lib/types.ts'
import { KNOWLEDGE } from '../src/config/knowledge.ts'
import { setActiveBusiness } from '../src/lib/businessRuntime.ts'

setActiveBusiness('erth')

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

let booking = emptyBooking('en')
let step: any = 'await_intent'
const g = greet('en', true)
step = g.nextStep
booking = { ...booking, ...g.bookingUpdates }
console.log('GREET_OK', g.toolCalls[0].tool)
assert(/Erth/i.test(g.text), 'erth greeting')

const msg =
  'I need a room for 2 adults and 1 child, check-in 2026-10-10, check-out 2026-10-13, late check-in after 10pm. Name Ahmed Al Mansoori, phone +971 50 555 5555'
let r = processGuestMessage({
  text: msg,
  step,
  booking,
  language: 'en',
  afterHours: true,
  humanTakeover: false,
})
booking = { ...booking, ...r.bookingUpdates }
step = r.nextStep
console.log('STEP', step)
console.log('FIELDS', booking.guestName, booking.adults, booking.children, booking.checkIn, booking.checkOut, booking.phone)
assert(/Ahmed/i.test(booking.guestName), 'Ahmed name parsed')
assert(booking.checkIn === '2026-10-10', 'check-in date')
assert(booking.checkOut === '2026-10-13', 'check-out date')

r = processGuestMessage({
  text: 'Yes please',
  step,
  booking,
  language: 'en',
  afterHours: true,
  humanTakeover: false,
})
console.log('OUTCOME', r.outcome)
console.log('NOTIFY', r.createNotification?.body)
assert(r.outcome === 'after_hours_saved' || r.outcome === 'booked_inquiry', 'happy path outcome')
assert(!!r.createNotification?.body, 'desk notify on happy path')
assert(!/modified|changed your booking|cancelled your/i.test(r.text), 'happy path does not claim modify')

r = processGuestMessage({
  text: 'agent please',
  step: 'await_intent',
  booking: emptyBooking('en'),
  language: 'en',
  afterHours: true,
  humanTakeover: false,
})
console.log('ESCALATE', r.escalate, r.outcome)
assert(r.escalate === true, 'escalate flag')
assert(r.outcome === 'transferred', 'escalate outcome')
assert(!!r.createTicket, 'escalate creates ticket')

// Modify / cancel — callback only, never claim live change
r = processGuestMessage({
  text: 'I need to change my booking. Name Sara Khan, phone +971 50 111 2222, confirmation ERTH-88421, move check-in to 2026-11-05',
  step: 'await_intent',
  booking: emptyBooking('en'),
  language: 'en',
  afterHours: true,
  humanTakeover: false,
})
console.log('MODIFY', r.outcome, r.createNotification?.subject, r.createTicket?.reason)
assert(r.outcome === 'callback_requested', 'modify outcome callback_requested')
assert(r.createNotification?.subject === 'Booking change request: verify then call guest', 'modify notify subject')
assert(!!r.createTicket, 'modify creates ticket')
assert(/won.?t change a live|no live reservation was changed|call you back/i.test(r.text), 'modify safety copy')
assert(!/i (have )?changed|cancelled your reservation|updated your booking|confirmed the change/i.test(r.text), 'must not claim booking changed')
assert(
  r.toolCalls.some((t) => t.tool === 'create_desk_notification') &&
    r.toolCalls.some((t) => t.tool === 'update_booking_fields'),
  'modify tools logged',
)

// Arabic FAQ quality — no mojibake / Latin garbage in core keys
const arKeys = ['check_in', 'location', 'airport', 'dining', 'spa', 'parking', 'early_checkin', 'late_checkout'] as const
for (const key of arKeys) {
  const ar = KNOWLEDGE[key].ar
  assert(typeof ar === 'string' && ar.length > 10, `${key} ar present`)
  assert(!/Ã.|Â.|â€™|â€|ï¿½|\\u00|�/.test(ar), `${key} no mojibake`)
  assert(/[\u0600-\u06FF]/.test(ar), `${key} contains Arabic script`)
}
console.log('AR_FAQ_OK', arKeys.join(','))

console.log('SMOKE_PASS')
