/**
 * Verify the 5 MM Dental client-video scenarios after speech/branding fixes.
 */
import { setActiveBusiness } from '../src/lib/businessRuntime.ts'
import { greet, processGuestMessage } from '../src/lib/stateMachine.ts'
import { sanitizeForSpeech } from '../src/lib/speakSanitize.ts'
import { emptyBooking } from '../src/lib/types.ts'
import { mmDentalBusiness } from '../src/businesses/mm-dental.ts'

setActiveBusiness('mm-dental')

let failed = 0
function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg)
    failed++
  } else {
    console.log('PASS:', msg)
  }
}

const BAD_SPEECH = /[·•×*_#`]|\btimes\b|No live diary|from this channel|HH Dental|\bHH\b|0116\s*275|0116\s*276|0116\s*247/i

function checkSpoken(label: string, text: string) {
  const clean = sanitizeForSpeech(text)
  assert(!BAD_SPEECH.test(text), `${label}: raw reply has banned glyphs/notes/phones/HH — ${text.slice(0, 100)}`)
  assert(!BAD_SPEECH.test(clean), `${label}: sanitized still bad — ${clean.slice(0, 100)}`)
  assert(/[.!?]$/.test(clean.trim()), `${label}: needs end punctuation for TTS pause`)
  // middle-dot never spoken
  assert(!/[·•×]/.test(clean), `${label}: list glyph survived sanitize`)
  return clean
}

function turn(text: string, step: string, booking: ReturnType<typeof emptyBooking>, afterHours: boolean) {
  return processGuestMessage({
    text,
    step: step as never,
    booking,
    language: 'en',
    afterHours,
    humanTakeover: false,
  })
}

// Branding config
assert(mmDentalBusiness.name === 'MM Dental Care', 'name MM Dental Care')
assert(mmDentalBusiness.logoText === 'MM', 'logoText MM')
assert(!/HH/i.test(mmDentalBusiness.name + mmDentalBusiness.logoText), 'no HH in brand')
assert(/demo/i.test(mmDentalBusiness.deskDisplayPhone || ''), 'deskDisplayPhone is demo placeholder')
assert(!/0116/.test(mmDentalBusiness.deskDisplayPhone || ''), 'desk phone not real Leicester line')

// —— 1 Same-day emergency ——
{
  const g = greet('en', false)
  checkSpoken('1 greet', g.text)
  assert(/MM Dental Care/i.test(g.text), '1 greets as MM')
  let booking = emptyBooking('en')
  let r = turn(
    "Hi, I've got really bad toothache, can I get seen today? Uppingham Road. Name James Patel, phone 07700 900123, new patient.",
    g.nextStep,
    booking,
    false,
  )
  booking = { ...booking, ...r.bookingUpdates }
  checkSpoken('1 emergency', r.text)
  assert(/£50|50/.test(r.text), '1 offers fee')
  assert(!/closed right now/i.test(r.text), '1 in-hours does not say closed')
  if (/shall i send|just to confirm/i.test(r.text)) {
    r = turn('Yes please', r.nextStep, booking, false)
    checkSpoken('1 confirm', r.text)
    assert(/passed this to the team|confirm your time/i.test(r.text), '1 caller-friendly confirm')
    assert(!/live diary|from this channel/i.test(r.text), '1 no internal note spoken')
    assert(r.createTicket?.priority === 'urgent', '1 urgent ticket')
  }
}

// —— 2 Membership & fees ——
{
  let r = turn('Do you do membership plans?', 'await_intent', emptyBooking('en'), false)
  checkSpoken('2 membership', r.text)
  assert(/£13\.50/.test(r.text), '2 membership price')
  assert(/Pay as you go is also available\./i.test(sanitizeForSpeech(r.text)), '2 pay-as-you-go sentence')
  r = turn('How much is an emergency appointment?', 'await_intent', emptyBooking('en'), false)
  checkSpoken('2 fee', r.text)
  assert(/£50/.test(r.text), '2 emergency fee')
}

// —— 3 Saturday hours ——
{
  const r = turn('What time are you open on Saturday?', 'await_intent', emptyBooking('en'), false)
  const spoken = checkSpoken('3 hours', r.text)
  assert(/Uppingham/i.test(spoken) && /Upperton/i.test(spoken), '3 both practices')
  assert(!/[·•]/.test(spoken), '3 no middle dots')
  assert(!/0116/.test(spoken), '3 no phone numbers spoken')
}

// —— 4 Reschedule ——
{
  const r = turn(
    'I need to move my appointment on Thursday. Name Alex Reed, phone 07700 900999',
    'await_intent',
    emptyBooking('en'),
    false,
  )
  checkSpoken('4 reschedule', r.text)
  assert(/call you to confirm your new time/i.test(r.text), '4 caller-friendly')
  assert(!/confirm your appointment shortly/i.test(r.text), '4 no old confirm wording')
  assert(!/No live diary|from this channel/i.test(r.text), '4 no internal note')
  assert(r.outcome === 'callback_requested', '4 callback')
  // Staff ticket may still note no live write
  assert(!!r.createTicket, '4 staff ticket exists')
}

// —— 5 After-hours emergency ——
{
  const g = greet('en', true)
  checkSpoken('5 greet', g.text)
  assert(/closed right now/i.test(g.text), '5 greeting mentions closed once')
  const closedCountGreet = (g.text.match(/closed right now/gi) || []).length
  assert(closedCountGreet === 1, '5 greeting says closed exactly once')

  let booking = emptyBooking('en')
  let r = turn(
    "It's 9pm — my filling fell out and it's killing me. Name Sarah Khan, phone 07700 900456, existing patient, Uppingham Road.",
    g.nextStep,
    booking,
    true,
  )
  booking = { ...booking, ...r.bookingUpdates }
  checkSpoken('5 emergency reply', r.text)
  assert(!/closed right now/i.test(r.text), '5 does NOT repeat closed greeting after caller speaks')
  assert(/urgent/i.test(r.text), '5 marks urgent')

  if (/shall i send|just to confirm/i.test(r.text)) {
    r = turn('Yes please', r.nextStep, booking, true)
    checkSpoken('5 finalize', r.text)
    assert(!/closed right now/i.test(r.text), '5 finalize does not re-say closed')
    assert(/call you first thing|when we open/i.test(r.text), '5 promises morning callback')
    assert(r.createTicket?.priority === 'urgent', '5 urgent ticket')
  }
}

// sanitize unit: middle-dot → no "times" glyph
{
  const s = sanitizeForSpeech('Name: James · Phone: 07700 · Patient: new')
  assert(!/[·•]/.test(s), 'sanitize strips middle dots')
  assert(/James/.test(s) && /07700/.test(s), 'sanitize keeps content')
  assert(!/\btimes\b/i.test(s), 'sanitize output has no times word')
}

if (failed) {
  console.error(`\n${failed} FAILURE(S)`)
  process.exit(1)
}
console.log('\nDENTAL_VOICE_FIX_PASS')
