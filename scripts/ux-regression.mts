/**
 * UX regression suite for hospitality receptionist demo.
 * Run: npm run ux
 */
import { greet, processGuestMessage, parseStayDates, parseName, parseRooms, parseGuests, parseRoomLayout, parsePartyComposition, parseDate, isGoodbyePhrase, detectIntent } from '../src/lib/stateMachine.ts'
import { emptyBooking, type BookingFields, type ConversationStep } from '../src/lib/types.ts'

let failed = 0
let passed = 0

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg)
    failed++
    return false
  }
  console.log('PASS:', msg)
  passed++
  return true
}

function turn(
  text: string,
  step: ConversationStep,
  booking: BookingFields,
  language: 'en' | 'ar' = 'en',
) {
  return processGuestMessage({
    text,
    step,
    booking,
    language,
    afterHours: true,
    humanTakeover: false,
  })
}

function apply(booking: BookingFields, updates: Partial<BookingFields>): BookingFields {
  return { ...booking, ...updates }
}

// --- 1 Ahmed happy path ---
{
  let booking = emptyBooking('en')
  let step: ConversationStep = greet('en', true).nextStep
  let r = turn(
    'I need a room for 2 adults and 1 child, check-in 2026-10-10, check-out 2026-10-13, late check-in after 10pm. Name Ahmed Al Mansoori, phone +971 50 555 5555',
    step,
    booking,
  )
  booking = apply(booking, r.bookingUpdates)
  step = r.nextStep
  r = turn('Yes please', step, booking)
  assert(r.outcome === 'after_hours_saved', '1 Ahmed Yes → after_hours_saved')
  assert(/Ahmed/i.test(booking.guestName), '1 Ahmed name')
  assert(booking.adults === 2 && booking.children === 1, '1 Ahmed guests')
  assert(booking.checkIn === '2026-10-10' && booking.checkOut === '2026-10-13', '1 Ahmed dates')
}

// --- 2 escalate ---
{
  const r = turn('agent please', 'await_intent', emptyBooking('en'))
  assert(r.outcome === 'transferred' && r.escalate === true && !!r.createTicket, '2 agent please → transferred + ticket')
}

// --- 3 modify Sara Khan ---
{
  const r = turn(
    'I need to change my booking. Name Sara Khan, phone +971 50 111 2222, confirmation ERTH-88421, move check-in to 2026-11-05',
    'await_intent',
    emptyBooking('en'),
  )
  const name = r.bookingUpdates.guestName || ''
  assert(r.outcome === 'callback_requested', '3 modify → callback_requested')
  assert(/Sara\s+Khan/i.test(name), '3 guestName includes Sara Khan')
  assert(!/I Need To Change/i.test(name) && !/Need To Change My Booking/i.test(name), '3 guestName is not full sentence')
  assert(/Sara Khan/i.test(r.createNotification?.body || '') || /Sara Khan/i.test(name), '3 notify/ticket identity Sara')
}

// --- 4 rates ---
{
  const r = turn('How much is a deluxe room per night?', 'await_intent', emptyBooking('en'))
  assert(r.nextStep !== 'collect_check_in', '4 rates does NOT jump to collect_check_in')
  assert(r.intent === 'rates' || /rate|reservations confirms|depend/i.test(r.text), '4 rates framing')
  assert(!/what is your check-in/i.test(r.text), '4 rates does not ask check-in first')
}

// --- 5 availability confirm-now ---
{
  const r = turn(
    'Do you have availability? Confirm my booking now for Oct 10–13 for 2 adults',
    'await_intent',
    emptyBooking('en'),
  )
  const b = apply(emptyBooking('en'), r.bookingUpdates)
  assert(
    (b.checkIn && b.checkOut) || r.nextStep !== 'await_intent',
    '5 availability extracts dates or enters inquiry collect',
  )
  assert(/10/.test(b.checkIn || '') && /13/.test(b.checkOut || ''), '5 Oct 10–13 extracted')
  assert(b.adults === 2, '5 adults=2 extracted')
  assert(!/you are confirmed|booking is confirmed|room is available|inventory is free/i.test(r.text), '5 no false confirmation')
  assert(/reservations|inquiry|callback|confirm availability/i.test(r.text), '5 honest inquiry framing')
}

// --- 6 spa then Nora book ---
{
  let booking = emptyBooking('en')
  let r = turn('I want a spa appointment Friday afternoon', 'await_intent', booking)
  booking = apply(booking, r.bookingUpdates)
  let step = r.nextStep
  assert(step === 'dining_details', '6 spa opens dining_details collect')
  r = turn(
    'ok book a room for 1 adult check-in 2026-11-01 check-out 2026-11-03 name Nora phone +971501234567',
    step,
    booking,
  )
  booking = apply(booking, r.bookingUpdates)
  step = r.nextStep
  assert(!/Spa request/i.test(r.createNotification?.subject || ''), '6 did not finalize spa notify')
  assert(/Nora/i.test(booking.guestName), '6 Nora name carried')
  assert(booking.checkIn === '2026-11-01' && booking.checkOut === '2026-11-03', '6 Nora dates')
  if (step === 'confirm_summary') {
    r = turn('yes', step, booking)
  }
  assert(
    r.outcome === 'after_hours_saved' || r.outcome === 'booked_inquiry' || step === 'confirm_summary' || step.startsWith('collect'),
    '6 reservation path for Nora (not spa)',
  )
  if (step === 'confirm_summary' || r.outcome) {
    assert(/Nora/i.test(booking.guestName) && !/Spa request/i.test(r.createNotification?.subject || ''), '6 Nora inquiry not spa')
  }
}

// --- 7 both dates ---
{
  let booking = emptyBooking('en')
  let r = turn('want a room', 'await_intent', booking)
  booking = apply(booking, r.bookingUpdates)
  let step = r.nextStep
  r = turn('ok check-in 10 October check-out 13 October', step, booking)
  booking = apply(booking, r.bookingUpdates)
  assert(!!booking.checkIn && !!booking.checkOut, '7 both check-in and check-out set')
  assert(booking.checkIn.includes('-10-10') && booking.checkOut.includes('-10-13'), '7 Oct 10 and 13')
  assert(r.nextStep !== 'collect_check_out', '7 skipped checkout loop')
}

// --- 8 rooms vs guests messy path ---
{
  let booking = emptyBooking('en')
  let r = turn('want a room', 'await_intent', booking)
  booking = apply(booking, r.bookingUpdates)
  let step = r.nextStep
  assert(booking.rooms === 1, '8 want a room implies rooms=1')
  r = turn('next Friday to Sunday', step, booking)
  booking = apply(booking, r.bookingUpdates)
  step = r.nextStep
  assert(!!booking.checkIn && !!booking.checkOut, '8 Friday–Sunday dates set')
  assert(step !== 'collect_rooms', '8 skip collect_rooms when rooms already set')
  assert(step === 'collect_guests' || step === 'collect_name', '8 advances to guests or name')
  r = turn('2 people', step, booking)
  booking = apply(booking, r.bookingUpdates)
  step = r.nextStep
  assert(booking.adults === 2, '8 “2 people” → adults=2')
  assert(booking.rooms === 1, '8 rooms stay 1 (not 2)')
  assert(step === 'collect_name' || step === 'collect_rooms', '8 advances past guests dump')
}

// --- 9 dining one-shot Layla ---
{
  const r = turn(
    'table for 4 tomorrow at 8pm at Al Rimal, name Layla, +971509998887',
    'await_intent',
    emptyBooking('en'),
  )
  assert(!!r.createNotification, '9 dining one-shot creates notify')
  assert(/Layla/i.test(r.createNotification?.body || '') || /Layla/i.test(r.bookingUpdates.guestName || ''), '9 Layla in notify')
  assert(/4|party/i.test(r.createNotification?.body || '') || r.bookingUpdates.diningParty === 4, '9 party 4 captured')
  assert(!/for which date and time/i.test(r.text), '9 did not re-ask date/time/party')
}

// --- 10 complaint Omar ---
{
  const r = turn(
    'There is a leak in the shower. Name Omar, phone +971508887766',
    'await_intent',
    emptyBooking('en'),
  )
  const sub = r.createNotification?.subject || ''
  const body = r.createNotification?.body || ''
  assert(/Omar/i.test(sub) || /Omar/i.test(body), '10 complaint notify contains Omar')
  assert(/\+971508887766|971508887766/.test(sub + body + (r.bookingUpdates.phone || '')), '10 complaint contains phone')
  assert(!!r.createTicket, '10 complaint creates ticket')
}

// --- 11 FAQ routing: airport / parking / Dubai Marina ---
{
  const air = turn('How far from the airport?', 'await_intent', emptyBooking('en'))
  assert(/15\s*minutes|airport|Zayed/i.test(air.text) && !/spread out|golf-cart|campus map/i.test(air.text), '11a airport distance FAQ')
  const pick = turn('airport pickup?', 'await_intent', emptyBooking('en'))
  assert(/airport|shuttle|pick/i.test(pick.text), '11b airport pickup FAQ')
  const park = turn('Is parking free?', 'await_intent', emptyBooking('en'))
  assert(/free|parking|valet/i.test(park.text) && !/deluxe 36|three-bedroom villa|inventory/i.test(park.text), '11c parking free FAQ')
  const dubai = turn('Is Erth in Dubai Marina?', 'await_intent', emptyBooking('en'))
  assert(/Abu Dhabi|Khor Al Maqta/i.test(dubai.text) && /not Dubai Marina|Dubai Marina/i.test(dubai.text), '11d corrects Dubai Marina')
}

// --- 12 WhatsApp-style: guest counts on rooms step ---
{
  let booking = emptyBooking('en')
  let r = turn('Room pls', 'await_intent', booking)
  booking = apply(booking, r.bookingUpdates)
  let step = r.nextStep
  r = turn('15 oct to 18 oct', step, booking)
  booking = apply(booking, r.bookingUpdates)
  step = r.nextStep
  r = turn('2 adults 1 kid', step, booking)
  booking = apply(booking, r.bookingUpdates)
  step = r.nextStep
  assert(booking.adults === 2 && booking.children === 1, '12 guests 2 adults 1 kid kept')
  assert(booking.rooms === 1, '12 rooms=1 from Room pls')
  assert(!/kids club|Kids’ pools|playground/i.test(r.text) || /guest name|How many rooms/i.test(r.text), '12 not kids-club FAQ dump')
  assert(step === 'collect_name' || step === 'collect_rooms', '12 continues booking collect')
  r = turn('Name Fatima Ali', step, booking)
  booking = apply(booking, r.bookingUpdates)
  assert(/Fatima/i.test(booking.guestName), '12 name accepted after guests')
}

// --- 13 National Day family of 4 ---
{
  const r = turn(
    'National Day weekend sold out? family of 4 for 2 nights',
    'await_intent',
    emptyBooking('en'),
  )
  const b = apply(emptyBooking('en'), r.bookingUpdates)
  assert(r.intent === 'reservation' || r.nextStep.startsWith('collect'), '13 starts booking inquiry')
  assert(b.adults === 2 && b.children === 2, '13 family of 4 → 2 adults 2 children')
  assert(!/confirmed available|you are booked|inventory is free|sold out/i.test(r.text), '13 no false availability')
  // Optional DEMO National Day date mapping
  if (b.checkIn) {
    assert(b.checkIn.startsWith('2026-12'), '13 DEMO National Day window mapped when present')
  }
}

// --- 14 mid-booking spa FAQ interrupt ---
{
  let booking = emptyBooking('en')
  let r = turn('book a room', 'await_intent', booking)
  booking = apply(booking, r.bookingUpdates)
  let step = r.nextStep
  assert(step === 'collect_check_in', '14 on collect_check_in')
  r = turn('what are spa hours?', step, booking)
  assert(/Valmont|spa|11:00|20:00|treatment/i.test(r.text), '14 answers spa')
  assert(r.nextStep === 'collect_check_in', '14 resumes check-in collect')
  assert(/check-in/i.test(r.text), '14 re-asks check-in after spa')
}

// --- 15 Booking.com already paid → modify, not new booking ---
{
  const r = turn(
    'Confirm booking, I already paid on Booking.com',
    'await_intent',
    emptyBooking('en'),
  )
  assert(r.intent === 'modify' || r.nextStep === 'modify_collect' || r.outcome === 'callback_requested', '15 modify/OTA path')
  assert(r.nextStep !== 'collect_check_in', '15 does NOT start new booking collect_check_in')
  assert(/existing|OTA|Booking\.com|confirmation|won’t start a new|will verify/i.test(r.text), '15 OTA/callback framing')
}

// --- 16 Arabic greeting ≠ rates ---
{
  const r = turn('السلام عليكم', 'await_intent', emptyBooking('en'))
  assert(/وعليكم السلام|مرحبا|مساعدتكم|حجز/i.test(r.text), '16 Arabic greeting reply')
  assert(!/سعر|أسعار|rates depend|quote final rates/i.test(r.text), '16 not rates FAQ')
}

// --- 17 room pls → dates → skip rooms re-ask ---
{
  let booking = emptyBooking('en')
  let r = turn('Room pls', 'await_intent', booking)
  booking = apply(booking, r.bookingUpdates)
  assert(booking.rooms === 1, '17 rooms=1 from Room pls')
  r = turn('15 oct to 18 oct', r.nextStep, booking)
  booking = apply(booking, r.bookingUpdates)
  assert(booking.checkIn.includes('-10-15') && booking.checkOut.includes('-10-18'), '17 dates set')
  assert(r.nextStep !== 'collect_rooms', '17 does NOT re-ask How many rooms')
  assert(/adults|children|guests|guest name/i.test(r.text), '17 asks next missing field')
  assert(!/How many rooms/i.test(r.text), '17 reply omits rooms question')
}

// --- 18 collect_special late check-in vs FAQ ---
{
  let booking = emptyBooking('en')
  booking = {
    ...booking,
    guestName: 'Test Guest',
    phone: '+971501111111',
    checkIn: '2026-10-10',
    checkOut: '2026-10-13',
    rooms: 1,
    adults: 2,
    children: 0,
  }
  let r = turn('late check-in please', 'collect_special', booking)
  assert(/late check/i.test(r.bookingUpdates.specialRequests || ''), '18 late check-in saved as special')
  assert(r.nextStep === 'confirm_summary', '18 advances to confirm')
  assert(!/Check-in from 15:00|photo ID and a credit card/i.test(r.text), '18 not general check-in FAQ')
}

// --- 19 collect_special yes/none do not store "yes" ---
{
  let booking = emptyBooking('en')
  booking = {
    ...booking,
    guestName: 'Test Guest',
    phone: '+971501111111',
    checkIn: '2026-10-10',
    checkOut: '2026-10-13',
    rooms: 1,
    adults: 2,
    children: 0,
  }
  let r = turn('yes', 'collect_special', booking)
  assert((r.bookingUpdates.specialRequests ?? 'x') === '', '19a yes → empty special')
  assert(!/^yes$/i.test(r.bookingUpdates.specialRequests || 'x'), '19a special is not the string yes')
  r = turn('none', 'collect_special', booking)
  assert((r.bookingUpdates.specialRequests ?? 'x') === '', '19b none → empty special')
}

// --- 20 multi-field dump mid-booking (labeled — keep working) ---
{
  let booking = emptyBooking('en')
  booking = { ...booking, rooms: 1 }
  let r = turn('book a room', 'await_intent', booking)
  booking = apply(booking, r.bookingUpdates)
  r = turn(
    'check-in 2026-11-10 check-out 2026-11-13, 2 adults, name Nora Hassan, phone +971509998877',
    'collect_check_in',
    booking,
  )
  booking = apply(booking, r.bookingUpdates)
  assert(booking.checkIn === '2026-11-10' && booking.checkOut === '2026-11-13', '20 dates applied')
  assert(booking.adults === 2, '20 adults applied')
  assert(/Nora/i.test(booking.guestName), '20 name applied')
  assert(/\+971509998877/.test(booking.phone), '20 phone applied')
  assert(r.nextStep === 'collect_special' || r.nextStep === 'confirm_summary', '20 advanced past name/phone')
}

// --- 21 unlabeled dump (real WhatsApp — no "name"/"phone" labels) ---
{
  let booking = emptyBooking('en')
  booking = { ...booking, rooms: 1 }
  let r = turn('book a room', 'await_intent', booking)
  booking = apply(booking, r.bookingUpdates)
  // spa interrupt then unlabeled dump
  r = turn('what are spa hours?', 'collect_check_in', booking)
  assert(r.nextStep === 'collect_check_in', '21 still on check-in after spa')
  r = turn('15 oct to 18 oct, 2 adults, Maya Khan, +971501234567', 'collect_check_in', booking)
  booking = apply(booking, r.bookingUpdates)
  assert(booking.checkIn.includes('-10-15') && booking.checkOut.includes('-10-18'), '21 unlabeled dates')
  assert(booking.adults === 2, '21 unlabeled adults=2')
  assert((booking.children ?? 0) === 0, '21 children=0 when only 2 adults')
  assert(booking.guestName === 'Maya Khan', '21 unlabeled name Maya Khan')
  assert(/\+971501234567/.test(booking.phone.replace(/\s/g, '')), '21 unlabeled phone')
  assert(r.nextStep !== 'collect_name', '21 does not re-ask guest name')
}

// --- 22 unlabeled dump alternate order ---
{
  const r = turn(
    'Maya Khan, 2 adults 1 kid, 20 oct - 22 oct, +971501234567',
    'collect_check_in',
    { ...emptyBooking('en'), rooms: 1 },
  )
  const b = apply({ ...emptyBooking('en'), rooms: 1 }, r.bookingUpdates)
  assert(b.guestName === 'Maya Khan', '22 name first dump')
  assert(b.adults === 2 && b.children === 1, '22 guests 2+1')
  assert(b.checkIn.includes('-10-20') && b.checkOut.includes('-10-22'), '22 date range')
  assert(/\+971501234567/.test(b.phone.replace(/\s/g, '')), '22 phone')
}

// --- 23 vague book phrases imply rooms=1 ---
{
  for (const phrase of ['I want to book', 'Book room please', 'book please', "I'd like to book"]) {
    const r = turn(phrase, 'await_intent', emptyBooking('en'))
    const b = apply(emptyBooking('en'), r.bookingUpdates)
    assert(b.rooms === 1, `23 rooms=1 from “${phrase}”`)
    assert(r.nextStep !== 'collect_rooms', `23 “${phrase}” not stuck on collect_rooms`)
    assert(
      r.nextStep === 'collect_check_in' || r.nextStep === 'collect_check_out' || r.nextStep === 'collect_guests',
      `23 “${phrase}” advances to dates/guests`,
    )
  }
  // Explicit count still wins
  const two = turn('I need 2 rooms', 'await_intent', emptyBooking('en'))
  assert(apply(emptyBooking('en'), two.bookingUpdates).rooms === 2, '23 explicit 2 rooms wins')
  // OTA must not become new book with rooms=1
  const ota = turn('Confirm booking, I already paid on Booking.com', 'await_intent', emptyBooking('en'))
  assert(ota.nextStep !== 'collect_check_in', '23 OTA still not new booking collect')
  assert(ota.intent === 'modify' || ota.nextStep === 'modify_collect', '23 OTA stays modify')
  assert(ota.bookingUpdates.rooms !== 1, '23 OTA does not force rooms=1 as new reservation')
}

// --- parser unit sanity ---
{
  assert(parseName('Name Sara Khan, phone +971') === 'Sara Khan', 'parseName Sara Khan')
  assert(
    parseName('15 oct to 18 oct, 2 adults, Maya Khan, +971501234567') === 'Maya Khan',
    'parseName unlabeled Maya Khan',
  )
  assert(parseRooms('2 people') === null, 'parseRooms ignores 2 people')
  assert(parseGuests('2 people').adults === 2, 'parseGuests 2 people')
  assert(parseGuests('one room').adults === null, 'parseGuests ignores one room')
  assert(parseGuests('2 adults 1 kid').adults === 2 && parseGuests('2 adults 1 kid').children === 1, 'parseGuests 2 adults 1 kid')
  assert(parseGuests('family of 4').adults === 2 && parseGuests('family of 4').children === 2, 'parseGuests family of 4')
  assert(parseGuests('1 adult and 2 children').adults === 1 && parseGuests('1 adult and 2 children').children === 2, 'parseGuests 1 adult 2 children')
  assert(parseGuests('2 adults and 1 grandparent').adults === 3, 'parseGuests adults + grandparent')
  assert(parseGuests('couple with 2 kids').adults === 2 && parseGuests('couple with 2 kids').children === 2, 'parseGuests couple with kids')
  assert(parseGuests('2 couples').adults === 4 && parseGuests('2 couples').children === 0, 'parseGuests 2 couples → 4 adults')
  assert(parseRoomLayout('2 couples').rooms === 2, 'parseRoomLayout 2 couples → 2 rooms')
  assert(
    parseGuests('1 couple and 1 family with 2 children').adults === 4 &&
      parseGuests('1 couple and 1 family with 2 children').children === 2,
    'parseGuests couple + family with 2 kids',
  )
  assert(parseRoomLayout('1 couple and 1 family with 2 children').rooms === 2, 'parseRoomLayout couple + family → 2 rooms')
  const stay = parseStayDates('check-in 10 October check-out 13 October')
  assert(!!stay.checkIn && !!stay.checkOut, 'parseStayDates both dates')
  const fromToday = parseStayDates('for two days from today')
  assert(!!fromToday.checkIn && !!fromToday.checkOut, 'parseStayDates two days from today')
  {
    const [y, m, d] = fromToday.checkIn!.split('-').map((x) => parseInt(x, 10))
    const expectedOut = new Date(y, m - 1, d + 2)
    const out = fromToday.checkOut!
    const [oy, om, od] = out.split('-').map((x) => parseInt(x, 10))
    assert(
      oy === expectedOut.getFullYear() && om === expectedOut.getMonth() + 1 && od === expectedOut.getDate(),
      'parseStayDates checkout = today + 2',
    )
  }
  const oct = parseStayDates('from 8 October for 2 days')
  assert(oct.checkIn?.endsWith('-10-08') || oct.checkIn?.includes('10-08'), 'parseStayDates 8 Oct check-in')
  assert(oct.checkOut?.endsWith('-10-10') || oct.checkOut?.includes('10-10'), 'parseStayDates 8 Oct + 2 → 10 Oct')
  const layout = parseRoomLayout('two separate rooms one for the couple and one for the children')
  assert(layout.rooms === 2, 'parseRoomLayout rooms=2')
  assert(!!layout.note && /couple|children/i.test(layout.note), 'parseRoomLayout note')
}

// --- 24 couple + kids separate rooms + duration dates ---
{
  const r = turn(
    'I need two separate rooms — one for the couple and one for the children. 2 adults and 2 kids, from 8 October for 2 days',
    'await_intent',
    emptyBooking('en'),
  )
  const b = apply(emptyBooking('en'), r.bookingUpdates)
  assert(b.rooms === 2, '24 rooms=2 for couple+kids layout')
  assert(b.adults === 2 && b.children === 2, '24 guests 2+2')
  assert(!!b.checkIn && !!b.checkOut, '24 dates from 8 Oct for 2 days')
  assert(/layout|separate|couple|children/i.test(b.specialRequests || '') || b.rooms === 2, '24 layout noted or rooms set')
}

// --- 25 breakfast / pool complimentary FAQ ---
{
  const br = turn('Is breakfast complimentary?', 'await_intent', emptyBooking('en'))
  assert(/breakfast|Al Rimal|complimentary|included/i.test(br.text), '25 breakfast FAQ')
  assert(br.intent === 'faq' || /breakfast/i.test(br.text), '25 breakfast intent')
  const pool = turn('Is the swimming pool free for hotel guests?', 'await_intent', emptyBooking('en'))
  assert(/pool|complimentary|beach|guest/i.test(pool.text), '25 pool complimentary FAQ')
}

// --- 26 incomplete lead: no mega menu ---
{
  const a = turn('I need reservation for', 'await_intent', emptyBooking('en'))
  assert(a.nextStep === 'collect_check_in', '26 incomplete reservation → collect dates')
  assert(!/Etizan|weddings|Beetza|kids club/i.test(a.text), '26 no mega amenity dump')
  assert(/check-in|date|reservation/i.test(a.text), '26 asks for booking detail')
  const b = turn('I just need', 'await_intent', emptyBooking('en'))
  assert(!/Etizan|weddings|Beetza|kids club/i.test(b.text), '26 “I just need” no mega dump')
}

// --- 27 room types numbered picker ---
{
  const menu = turn('Which type of rooms do you have?', 'await_intent', emptyBooking('en'))
  assert(menu.nextStep === 'collect_room_type', '27 room menu → collect_room_type')
  assert(/1\).*Ubayya|Al Ubayya/i.test(menu.text), '27 lists Al Ubayya')
  assert(/4\).*Muradi|Al Muradi/i.test(menu.text), '27 lists Al Muradi')
  assert(/Reply with a number|رقم/i.test(menu.text), '27 asks to pick a number')
  const pick = turn('4', 'collect_room_type', emptyBooking('en'))
  const b = apply(emptyBooking('en'), pick.bookingUpdates)
  assert(/Muradi/i.test(b.roomCategory || ''), '27 pick 4 → Al Muradi')
  assert(pick.nextStep !== 'collect_room_type', '27 advances after pick')
}

// --- 28 two couples / couple+family party ---
{
  const two = turn(
    'We are 2 couples — need 2 couple rooms, from 10 October for 2 nights',
    'await_intent',
    emptyBooking('en'),
  )
  const b2 = apply(emptyBooking('en'), two.bookingUpdates)
  assert(b2.adults === 4, '28 two couples → 4 adults')
  assert(b2.rooms === 2, '28 two couples → 2 rooms')
  assert(!!b2.checkIn && !!b2.checkOut, '28 dates set')
  const mix = turn(
    '1 couple and 1 family with 2 children, 2 rooms, check-in tomorrow for 3 nights',
    'await_intent',
    emptyBooking('en'),
  )
  const bm = apply(emptyBooking('en'), mix.bookingUpdates)
  assert(bm.adults === 4 && bm.children === 2, '28 couple+family guests')
  assert(bm.rooms === 2, '28 couple+family rooms')
}

// --- 29 impress: AC ticket + upsell bare number ---
{
  const ac = turn('The AC is not working in room 412', 'await_intent', emptyBooking('en'))
  assert(!!ac.createTicket && ac.createTicket.priority === 'high', '29 AC creates high ticket')
  assert(/412|ENG|engineering|priority/i.test(ac.text + (ac.createTicket?.reason || '')), '29 AC room/ENG noted')
  assert(!!ac.createNotification, '29 AC desk notify')
  const up = turn('2', 'await_intent', { ...emptyBooking('en'), guestName: 'Sara', checkIn: '2026-10-10', checkOut: '2026-10-12' })
  assert(/breakfast/i.test(up.bookingUpdates.specialRequests || ''), '29 bare 2 → breakfast upsell')
  const notUpsell = turn('1 couple from tomorrow', 'await_intent', emptyBooking('en'))
  assert(!/early check-in/i.test(notUpsell.bookingUpdates.specialRequests || ''), '29 “1 couple” is not upsell')
}

// --- 30 goodbye + ROI finalize ticket + “N of Month” dates + couple with family ---
{
  assert(isGoodbyePhrase('no thanks'), '30 goodbye no thanks')
  assert(isGoodbyePhrase('setting band karna'), '30 goodbye Urdu band karna')
  assert(parseDate('12 of October 2026') === '2026-10-12', '30 12 of October 2026 → 12 not 20')
  assert(!!parseDate('8 of October')?.endsWith('-10-08'), '30 8 of October')
  const fam = parsePartyComposition('one couple with family')
  assert((fam.adults || 0) >= 4 && (fam.rooms || 0) >= 2, '30 couple with family → 4 adults / 2 rooms')
  const bye = turn('goodbye', 'completed', {
    ...emptyBooking('en'),
    guestName: 'Shahid',
    checkIn: '2026-10-12',
    checkOut: '2026-10-26',
  })
  assert(bye.end === true && bye.nextStep === 'completed', '30 goodbye ends call')
  assert(/goodbye|thank you/i.test(bye.text), '30 goodbye farewell')
  const booking = {
    ...emptyBooking('en'),
    guestName: 'Shahid Shahid',
    phone: '123456',
    checkIn: '2026-10-12',
    checkOut: '2026-10-26',
    adults: 2,
    children: 0,
    rooms: 1,
  }
  const fin = turn('yes confirm', 'confirm_summary', booking)
  assert(fin.end === true && !!fin.outcome, '30 finalize ends + outcome (inquiries saved)')
  assert(!!fin.createTicket, '30 finalize opens staff ticket')
  assert(!!fin.createNotification, '30 finalize desk WA')
}

// --- 31 rates → start enquiry / quick question (no menu loop) ---
{
  assert(detectIntent('start the enquiry') === 'reservation', '31 enquiry spelling → reservation')
  assert(detectIntent('start the inquiry') === 'reservation', '31 inquiry → reservation')
  assert(detectIntent('quick question') === 'faq', '31 quick question → faq')
  const start = turn('start the enquiry', 'await_intent', emptyBooking('en'))
  assert(start.nextStep === 'collect_check_in', '31 start enquiry opens check-in collect')
  assert(/check-in|reservation/i.test(start.text), '31 start enquiry asks check-in')
  assert(!/quick question/i.test(start.text), '31 start enquiry does not loop menu')
  const yesAfterRates = turn('yes', 'await_intent', emptyBooking('en'))
  assert(yesAfterRates.nextStep === 'collect_check_in', '31 bare yes starts inquiry collect')
  const qq = turn('quick question', 'await_intent', emptyBooking('en'))
  assert(/what('|’)s your question|parking|spa|room types/i.test(qq.text), '31 quick question asks for the question')
  assert(!/book a stay, change an existing/i.test(qq.text), '31 quick question does not re-offer dead menu')
}

console.log(`\nUX_REGRESSION ${failed === 0 ? 'PASS' : 'FAIL'} — ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
