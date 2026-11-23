/**
 * Dental industry conversation paths.
 * Booking requests are sent to the practice team — never live diary writes.
 * Never invent prices, dentist names, or free slots outside config.
 */

import type { BusinessConfig } from '../config/businessTypes'
import { getPresetForBusiness } from '../businesses'
import { sanitizeForSpeech, spokenBookingSummary } from './speakSanitize'
import type { BookingFields, ConversationStep, Intent, Language, Outcome } from './types'

/** Mirrors stateMachine.AgentReply — kept local to avoid circular imports. */
export interface DentalAgentReply {
  text: string
  toolCalls: Array<{ tool: string; args: Record<string, unknown>; result: string }>
  nextStep: ConversationStep
  bookingUpdates: Partial<BookingFields>
  intent?: Intent
  outcome?: Outcome
  escalate?: boolean
  createNotification?: { subject: string; body: string }
  createTicket?: {
    reason: string
    summary: string
    priority: 'normal' | 'high' | 'urgent'
  }
  end?: boolean
}

function isGoodbyePhrase(text: string): boolean {
  const t = text.toLowerCase().trim().replace(/[.…!]+$/g, '')
  if (t.length > 64) return false
  return /^(no thanks|no thank you|nothing else|that'?s (all|it)|goodbye|good bye|bye|hang up)\b/i.test(t)
}

function parsePhone(text: string): string | null {
  const m = text.match(
    /(?:\+?44\s?\d[\d\s]{8,14}|\+?\d{2,3}[\s-]?\d{2,4}[\s-]?\d{3,4}[\s-]?\d{3,4}|0\d{3,4}[\s-]?\d{3}[\s-]?\d{3,4}|07\d{3}[\s-]?\d{6})/,
  )
  return m ? m[0].replace(/\s+/g, ' ').trim() : null
}

function parseName(text: string): string | null {
  const labeled = text.match(
    /(?:(?:my\s+)?name\s+is|i'?m|i\s+am|this\s+is|name[:\s]+)\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})/i,
  )
  if (labeled?.[1]) return labeled[1].replace(/\b\w/g, (c) => c.toUpperCase())
  const uk = text.match(/\b([A-Z][a-z]+\s+[A-Z][a-z]+)\b/)
  return uk?.[1] ?? null
}

const DENTAL_COLLECT: ConversationStep[] = [
  'collect_name',
  'collect_phone',
  'collect_patient_type',
  'collect_practice',
  'collect_reason',
  'collect_preferred_time',
  'confirm_summary',
  'modify_collect',
]

export function detectDentalIntent(text: string): Intent {
  const t = text.toLowerCase()

  if (
    /\b(agent|human|receptionist|speak to (a |someone|a person)|talk to (a |someone|a person)|transfer)\b/i.test(
      t,
    )
  ) {
    return 'human'
  }
  if (isGoodbyePhrase(text)) return 'goodbye'

  if (
    /\b(toothache|tooth\s*ache|dental\s*emergency|abscess|swelling|bleeding|broken\s*tooth|knocked\s*(out\s*)?tooth|filling\s*fell|in\s*pain|killing\s*me|can'?t\s*(eat|sleep)|urgent)\b/i.test(
      t,
    ) ||
    /\b(really\s*bad|severe)\b.*\b(tooth|pain|gum)/i.test(t)
  ) {
    return 'emergency'
  }

  if (
    /\b(cancel|reschedule|move|change|postpone)\b.*\b(appointment|booking|slot)\b/i.test(t) ||
    /\b(appointment|booking)\b.*\b(cancel|reschedule|move|change)\b/i.test(t) ||
    /\bmove my appointment\b/i.test(t)
  ) {
    return 'modify'
  }

  if (/\b(membership|denplan|monthly\s*plan|payment\s*plan)\b/i.test(t)) return 'membership'

  if (
    /\b(how\s*much|price|cost|fee|fees|charge)\b/i.test(t) ||
    /\bemeragency\s*(appointment|fee|cost|price)\b/i.test(t)
  ) {
    return 'rates'
  }

  if (/\b(nhs|national\s*health)\b/i.test(t)) return 'nhs'

  if (/\b(new\s*patient|register|sign\s*up|join\s*(as|the)?)\b/i.test(t)) return 'new_patient'

  if (
    /\b(existing\s*patient|already\s*(a\s*)?patient|book(ing)?\s*(an?\s*)?appointment|see\s*(the\s*)?dentist)\b/i.test(
      t,
    )
  ) {
    return 'existing_patient'
  }

  if (/\b(appointment|booking|book)\b/i.test(t) && !/\b(cancel|reschedule|move|change)\b/i.test(t)) {
    return 'existing_patient'
  }

  if (
    /\b(open|hours|opening|what\s*time|saturday|sunday|weekday)\b/i.test(t) ||
    /\bwhen\s*(are\s*you|do\s*you)\s*open\b/i.test(t)
  ) {
    return 'hours'
  }

  if (
    /\b(where|location|address|which\s*practice|how\s*(do\s*i\s*)?find)\b/i.test(t) ||
    (/^\s*(uppingham|upperton|leicester)\b/i.test(t) && t.length < 80)
  ) {
    return 'location'
  }

  if (/\b(nervous|anxious|scared|afraid|phobia|haven'?t\s*(been|seen)|long\s*time)\b/i.test(t)) {
    return 'nervous'
  }

  if (/^(yes|yeah|yep|yup|correct|confirm|ok|okay|sure|please)[.!]?$/i.test(t.trim())) return 'confirm'
  if (/^(no|nope|not yet|cancel)[.!]?$/i.test(t.trim())) return 'deny'

  // FAQ keyword fallthrough
  return 'faq'
}

function matchDentalFaq(biz: BusinessConfig, text: string): string | null {
  for (const faq of biz.faqs) {
    if (faq.keywords?.test(text)) return faq.a
    const words = faq.q
      .toLowerCase()
      .replace(/[?.,]/g, '')
      .split(/\s+/)
      .filter((w) => w.length > 3)
    const hit = words.filter((w) => text.toLowerCase().includes(w)).length
    if (hit >= Math.min(2, words.length)) return faq.a
  }
  return null
}

function findPricing(biz: BusinessConfig, text: string): string | null {
  const t = text.toLowerCase()
  for (const p of biz.pricing) {
    const key = p.item.toLowerCase()
    if (
      (key.includes('emergency') && /emergency|toothache|pain/.test(t)) ||
      (key.includes('membership') && /membership|\bplans?\b|monthly/.test(t))
    ) {
      return `${p.item}: ${p.price}`
    }
  }
  // Exact item word overlap only for verified list — never invent
  for (const p of biz.pricing) {
    const tokens = p.item.toLowerCase().split(/\s+/).filter((w) => w.length > 3)
    if (tokens.some((tok) => t.includes(tok)) && /how\s*much|price|cost|fee/.test(t)) {
      return `${p.item}: ${p.price}`
    }
  }
  return null
}

function saturdayHours(biz: BusinessConfig): string {
  // One clear answer — do not append location.notes (they repeat the same facts)
  const open = biz.locations.find((loc) => !/phone lines only/i.test(loc.hours.sat))
  const phoneOnly = biz.locations.find((loc) => /phone lines only/i.test(loc.hours.sat))
  if (open && phoneOnly) {
    const hours = open.hours.sat
      .replace(/–/g, ' to ')
      .replace(/-/g, ' to ')
      .replace(/\s*phone lines only/i, '')
      .trim()
    const openShort = open.name.replace(/\s*Practice$/i, '')
    const phoneShort = phoneOnly.name.replace(/\s*Practice$/i, '')
    return `On Saturdays, our ${openShort} practice is open ${hours}. ${phoneShort} has phone lines only.`
  }
  const parts = biz.locations.map((loc) => {
    const hours = loc.hours.sat.replace(/–/g, ' to ').replace(/-/g, ' to ')
    if (/phone lines only/i.test(hours)) {
      return `${loc.name.replace(/\s*Practice$/i, '')} has phone lines only`
    }
    return `${loc.name.replace(/\s*Practice$/i, '')} is open ${hours}`
  })
  return `On Saturdays, ${parts.join('. ')}.`
}

function allHours(biz: BusinessConfig): string {
  return biz.locations
    .map((loc) => {
      const h = loc.hours
      return `${loc.name} at ${loc.address}: Monday ${h.mon}, Tuesday ${h.tue}, Wednesday ${h.wed}, Thursday ${h.thu}, Friday ${h.fri}, Saturday ${h.sat}, Sunday ${h.sun}`
    })
    .join('. ')
}

function locationBlurb(biz: BusinessConfig): string {
  // No real phone numbers in caller-facing speech/UI copy
  return biz.locations.map((loc) => `${loc.name} at ${loc.address}`).join('. ') + '.'
}

function parsePatientType(text: string): string | null {
  if (/\b(new\s*patient|i'?m\s*new|not\s*(a\s*)?patient|first\s*time|register)\b/i.test(text)) {
    return 'new'
  }
  if (/\b(existing|already\s*(a\s*)?patient|i'?m\s*(an?\s*)?existing|returning)\b/i.test(text)) {
    return 'existing'
  }
  return null
}

function parsePractice(text: string, biz: BusinessConfig): string | null {
  const t = text.toLowerCase()
  if (/no\s*preference|either|don'?t\s*mind|any\s*practice/i.test(t)) return 'No preference'
  for (const loc of biz.locations) {
    const short = loc.name.replace(/\s*Practice$/i, '').toLowerCase()
    if (t.includes(short) || t.includes(loc.name.toLowerCase())) return loc.name
    // street tokens
    const street = short.split(/\s+/)[0]
    if (street && street.length > 4 && t.includes(street)) return loc.name
  }
  if (/uppingham/i.test(t)) return 'Uppingham Road Practice'
  if (/upperton/i.test(t)) return 'Upperton Road Practice'
  return null
}

function extractDentalFields(text: string, biz: BusinessConfig): Partial<BookingFields> {
  const updates: Partial<BookingFields> = {}
  const name = parseName(text)
  const phone = parsePhone(text)
  const patientType = parsePatientType(text)
  const practice = parsePractice(text, biz)
  if (name) updates.guestName = name
  if (phone) updates.phone = phone
  if (patientType) updates.patientType = patientType
  if (practice) updates.practice = practice

  // Preferred day/time fragments
  const dayTime = text.match(
    /\b((mon|tues|wednes|thurs|fri|satur|sun)day|tomorrow|today|next\s+week|this\s+week)[^,.]*?(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?/i,
  )
  if (dayTime) updates.preferredDayTime = dayTime[0].trim()

  // Reason if mentioning treatment / tooth issue (short)
  if (
    /\b(toothache|check[\s-]?up|cleaning|fill(ing)?|crown|implant|whitening|invisalign|extraction|pain|swelling)\b/i.test(
      text,
    )
  ) {
    const reasonMatch = text.match(
      /\b(toothache|check[\s-]?up|cleaning|fill(?:ing)?|crown|implant|whitening|invisalign|extraction|pain|swelling|broken tooth)[^,.]*/i,
    )
    if (reasonMatch) updates.reason = reasonMatch[0].trim()
  }

  return updates
}

function nextDentalStep(b: BookingFields, emergency: boolean): ConversationStep {
  if (!b.guestName?.trim()) return 'collect_name'
  if (!b.phone?.trim()) return 'collect_phone'
  if (!b.patientType?.trim()) return 'collect_patient_type'
  if (!b.practice?.trim()) return 'collect_practice'
  if (!emergency && !b.reason?.trim()) return 'collect_reason'
  if (!emergency && !b.preferredDayTime?.trim()) return 'collect_preferred_time'
  if (emergency && !b.reason?.trim()) {
    // reason optional if already emergency context
  }
  return 'confirm_summary'
}

function askDentalStep(step: ConversationStep, emergency: boolean): string {
  switch (step) {
    case 'collect_name':
      return 'May I take your full name, please?'
    case 'collect_phone':
      return 'And the best phone number to reach you on?'
    case 'collect_patient_type':
      return 'Are you a new patient or an existing patient with us?'
    case 'collect_practice':
      return 'Which practice suits you better — Uppingham Road, Upperton Road, or no preference?'
    case 'collect_reason':
      return emergency
        ? 'Briefly, what’s the main problem so I can mark it for the team?'
        : 'What would you like the appointment for — for example a check-up, cleaning, or something else?'
    case 'collect_preferred_time':
      return 'What day and time work best for you? I’ll send a request to the practice team — they confirm the diary slot.'
    case 'confirm_summary':
      return ''
    default:
      return 'How else can I help?'
  }
}

/** Staff / ticket field summary (may use separators — not spoken raw). */
function buildDentalSummary(b: BookingFields, emergency: boolean): string {
  const type = b.patientType === 'new' ? 'new patient' : b.patientType === 'existing' ? 'existing patient' : '-'
  return [
    `Name: ${b.guestName || '-'}`,
    `Phone: ${b.phone || '-'}`,
    `Patient: ${type}`,
    `Practice: ${b.practice || '-'}`,
    `Reason: ${b.reason || (emergency ? 'Dental emergency' : '-')}`,
    emergency ? 'Priority: URGENT' : `Preferred: ${b.preferredDayTime || '-'}`,
  ].join(' | ')
}

function confirmSpeech(b: BookingFields, emergency: boolean): string {
  const summary = spokenBookingSummary({
    guestName: b.guestName,
    phone: b.phone,
    patientType: b.patientType,
    practice: b.practice,
    reason: b.reason,
    preferredDayTime: b.preferredDayTime,
    emergency,
  })
  return `Just to confirm, I have ${summary} Shall I send this request to the practice team?`
}

function finalizeDentalBooking(
  biz: BusinessConfig,
  booking: BookingFields,
  afterHours: boolean,
  emergency: boolean,
): DentalAgentReply {
  const preset = getPresetForBusiness(biz)
  const summary = buildDentalSummary(booking, emergency)
  const urgent = emergency
  const subject = urgent
    ? afterHours
      ? `URGENT dental emergency (after hours) — ${booking.guestName || 'patient'}`
      : `URGENT same-day emergency request — ${booking.guestName || 'patient'}`
    : afterHours
      ? `After-hours ${preset.wording.bookingNoun} request — ${booking.guestName || 'patient'}`
      : `${preset.wording.bookingNoun} request — ${booking.guestName || 'patient'}`

  const openHint = afterHours
    ? ` Team will call at opening (Uppingham Road from 8:30am).`
    : ''

  const body = [
    urgent ? 'URGENT' : 'Appointment request (not a live diary booking)',
    summary,
    afterHours ? biz.afterHoursMessage : 'In-hours request — practice team to confirm slot.',
    openHint,
  ]
    .filter(Boolean)
    .join(' · ')

  const severe = biz.emergency.severeAdvice
    ? ` ${biz.emergency.severeAdvice}`
    : ''

  // Caller-facing only — never mention live diary / channel internals
  const text = urgent
    ? afterHours
      ? `I've taken your details and marked this as urgent. The team will call you first thing when we open, from half past eight at Uppingham Road.${severe} Is there anything else?`
      : `I've passed this to the team as urgent, and they'll confirm your time shortly.${severe} Is there anything else I can help with?`
    : afterHours
      ? `I've passed this to the practice team. They'll call you back as soon as we open and confirm your appointment. Is there anything else?`
      : `I've passed this to the practice team and they'll confirm your appointment shortly. Is there anything else?`

  return {
    text: text.replace(/\s+/g, ' ').trim(),
    toolCalls: [
      { tool: 'confirm_booking_summary', args: { confirmed: true, emergency: urgent }, result: 'Patient confirmed' },
      { tool: 'create_desk_notification', args: { subject, body }, result: 'Practice notified' },
      {
        tool: 'escalate_to_human',
        args: { reason: subject },
        result: urgent ? 'URGENT ticket created' : 'Staff ticket created',
      },
    ],
    nextStep: 'completed',
    bookingUpdates: { isEmergency: urgent },
    outcome: afterHours ? 'after_hours_saved' : 'booked_inquiry',
    createNotification: { subject, body },
    createTicket: {
      reason: subject,
      summary,
      priority: urgent ? 'urgent' : 'normal',
    },
    end: true,
  }
}

function finalizeDentalModify(_biz: BusinessConfig, booking: BookingFields): DentalAgentReply {
  const subject = 'Appointment change request — verify then call patient'
  const body = [
    'CHANGE/CANCEL inquiry only (no live diary change).',
    `Patient: ${booking.guestName || '-'}`,
    `Phone: ${booking.phone || '-'}`,
    `Request: ${booking.modifyRequest || '-'}`,
    'Action: verify appointment then call patient back.',
  ].join(' · ')

  return {
    text: "Of course. I've passed this to the team. The team will call you to confirm your new time. Is there anything else?",
    toolCalls: [
      { tool: 'detect_intent', args: { intent: 'modify' }, result: 'modify' },
      {
        tool: 'update_booking_fields',
        args: {
          guestName: booking.guestName,
          phone: booking.phone,
          modifyRequest: booking.modifyRequest,
        },
        result: 'modify inquiry fields saved',
      },
      { tool: 'create_desk_notification', args: { subject, body }, result: 'Practice notified — change request' },
    ],
    nextStep: 'completed',
    bookingUpdates: {
      guestName: booking.guestName,
      phone: booking.phone,
      modifyRequest: booking.modifyRequest,
    },
    intent: 'modify',
    outcome: 'callback_requested',
    createNotification: { subject, body },
    createTicket: {
      reason: 'Appointment change / cancel request',
      summary:
        booking.modifyRequest ||
        'Patient requested change or cancel — verify then callback (no live diary write)',
      priority: 'normal',
    },
    end: true,
  }
}

function escalateDental(booking: BookingFields): DentalAgentReply {
  return {
    text: "Of course. I'll connect you with a colleague at the practice and leave a short summary of our conversation.",
    toolCalls: [
      {
        tool: 'escalate_to_human',
        args: { guestName: booking.guestName, phone: booking.phone },
        result: 'Human ticket created',
      },
    ],
    nextStep: 'escalated',
    bookingUpdates: {},
    intent: 'human',
    outcome: 'transferred',
    escalate: true,
    createTicket: {
      reason: 'Patient requested human agent',
      summary: 'Warm handoff — patient asked for a colleague',
      priority: 'normal',
    },
    end: true,
  }
}

function callbackUnknownPrice(_biz: BusinessConfig, topic: string, booking: BookingFields): DentalAgentReply {
  const subject = `Callback — confirm ${topic}`
  const body = `Patient asked about ${topic}. Do not invent a price. Name: ${booking.guestName || '-'} · Phone: ${booking.phone || '-'}. Team to confirm.`
  return {
    text: "I'll ask the team to confirm that for you. I don't want to give you an incorrect figure. I've logged a callback for the practice team.",
    toolCalls: [
      { tool: 'detect_intent', args: { intent: 'rates', topic }, result: 'no invented price — callback' },
      { tool: 'create_desk_notification', args: { subject, body }, result: 'Callback ticket' },
    ],
    nextStep: 'completed',
    bookingUpdates: {},
    intent: 'rates',
    outcome: 'callback_requested',
    createNotification: { subject, body },
    createTicket: {
      reason: subject,
      summary: body,
      priority: 'normal',
    },
    end: true,
  }
}

function startBookingCollect(
  biz: BusinessConfig,
  text: string,
  booking: BookingFields,
  afterHours: boolean,
  emergency: boolean,
  leadText: string,
): DentalAgentReply {
  const extracted = extractDentalFields(text, biz)
  const merged: BookingFields = {
    ...booking,
    ...extracted,
    isEmergency: emergency || booking.isEmergency,
    reason: extracted.reason || booking.reason || (emergency ? 'Dental emergency / pain' : booking.reason),
  }
  if (emergency) merged.isEmergency = true

  const next = nextDentalStep(merged, emergency)
  if (next === 'confirm_summary') {
    // Never re-state after-hours closed greeting here (said once at call start)
    const feeBit = emergency && !afterHours ? `${biz.emergency.message} ` : ''
    return {
      text: `${feeBit}${confirmSpeech(merged, emergency)}`.replace(/\s+/g, ' ').trim(),
      toolCalls: [
        { tool: 'update_booking_fields', args: extracted, result: 'fields updated' },
        { tool: 'detect_intent', args: { intent: emergency ? 'emergency' : 'reservation' }, result: 'ready to confirm' },
      ],
      nextStep: 'confirm_summary',
      bookingUpdates: merged,
      intent: emergency ? 'emergency' : 'reservation',
    }
  }

  const ask = askDentalStep(next, emergency)
  return {
    text: `${leadText} ${ask}`.replace(/\s+/g, ' ').trim(),
    toolCalls: [
      { tool: 'detect_intent', args: { intent: emergency ? 'emergency' : 'reservation' }, result: 'collecting' },
      { tool: 'update_booking_fields', args: extracted, result: 'partial fields' },
    ],
    nextStep: next,
    bookingUpdates: merged,
    intent: emergency ? 'emergency' : 'reservation',
  }
}

export function dentalGreet(biz: BusinessConfig, afterHours: boolean): DentalAgentReply {
  const text = afterHours
    ? biz.greetings.enAfterHours || biz.greetings.en
    : biz.greetings.en
  return {
    text: sanitizeForSpeech(text),
    toolCalls: [{ tool: 'greet', args: { language: 'en', afterHours, industry: 'dental' }, result: 'Greeting delivered' }],
    nextStep: 'await_intent',
    bookingUpdates: { language: 'en' },
  }
}

export function processDentalMessage(opts: {
  biz: BusinessConfig
  text: string
  step: ConversationStep
  booking: BookingFields
  language: Language
  afterHours: boolean
  humanTakeover: boolean
}): DentalAgentReply {
  const { biz, text, step, afterHours, humanTakeover } = opts
  // Dental demo is en-GB only; keep language field for shared store
  const booking = { ...opts.booking, language: 'en' as Language }
  const intent = detectDentalIntent(text)

  const withLang = (reply: DentalAgentReply): DentalAgentReply => ({
    ...reply,
    // Voice replies: no markdown, bullets, or internal channel notes
    text: sanitizeForSpeech(reply.text),
    bookingUpdates: { ...reply.bookingUpdates, language: 'en' },
  })

  if (humanTakeover) {
    return withLang(escalateDental(booking))
  }

  if (intent === 'human') return withLang(escalateDental(booking))

  if (intent === 'goodbye' && !DENTAL_COLLECT.includes(step)) {
    const name = booking.guestName ? `, ${booking.guestName}` : ''
    return withLang({
      text: `Thank you for calling ${biz.greetingName}${name}. The practice team will follow up if needed. Goodbye.`,
      toolCalls: [{ tool: 'end_conversation', args: { reason: 'patient_goodbye' }, result: 'Call ended' }],
      nextStep: 'completed',
      bookingUpdates: {},
      intent: 'goodbye',
      end: true,
    })
  }

  // Mid-flow confirm
  if (step === 'confirm_summary') {
    if (intent === 'confirm' || /^(yes|yeah|yep|please|confirm|ok|okay)/i.test(text.trim())) {
      return withLang(
        finalizeDentalBooking(biz, booking, afterHours, Boolean(booking.isEmergency)),
      )
    }
    if (intent === 'deny') {
      return withLang({
        text: 'No problem — what would you like me to change?',
        toolCalls: [],
        nextStep: 'collect_reason',
        bookingUpdates: {},
      })
    }
  }

  // Collect steps
  if (DENTAL_COLLECT.includes(step) && step !== 'confirm_summary' && step !== 'modify_collect') {
    const extracted = extractDentalFields(text, biz)
    // Field-specific capture
    if (step === 'collect_name' && !extracted.guestName) {
      const raw = text.trim().replace(/^(my name is|i'?m|i am)\s+/i, '')
      if (raw.length >= 2) extracted.guestName = raw.replace(/\b\w/g, (c) => c.toUpperCase())
    }
    if (step === 'collect_phone' && !extracted.phone) {
      const digits = text.replace(/[^\d+]/g, '')
      if (digits.length >= 8) extracted.phone = text.trim()
    }
    if (step === 'collect_patient_type' && !extracted.patientType) {
      if (/^new\b/i.test(text.trim())) extracted.patientType = 'new'
      else if (/^existing\b/i.test(text.trim())) extracted.patientType = 'existing'
    }
    if (step === 'collect_practice' && !extracted.practice) {
      extracted.practice = parsePractice(text, biz) || text.trim()
    }
    if (step === 'collect_reason' && !extracted.reason) {
      extracted.reason = text.trim()
    }
    if (step === 'collect_preferred_time' && !extracted.preferredDayTime) {
      extracted.preferredDayTime = text.trim()
    }

    const merged = { ...booking, ...extracted }
    const emergency = Boolean(merged.isEmergency)
    const next = nextDentalStep(merged, emergency)

    if (next === 'confirm_summary') {
      return withLang({
        text: confirmSpeech(merged, emergency),
        toolCalls: [{ tool: 'update_booking_fields', args: extracted, result: 'fields updated' }],
        nextStep: 'confirm_summary',
        bookingUpdates: merged,
      })
    }

    return withLang({
      text: askDentalStep(next, emergency),
      toolCalls: [{ tool: 'update_booking_fields', args: extracted, result: 'fields updated' }],
      nextStep: next,
      bookingUpdates: merged,
    })
  }

  if (step === 'modify_collect') {
    const name = parseName(text) || booking.guestName
    const phone = parsePhone(text) || booking.phone
    const merged = {
      ...booking,
      guestName: name || booking.guestName,
      phone: phone || booking.phone,
      modifyRequest: [booking.modifyRequest, text].filter(Boolean).join(' · '),
    }
    if (merged.guestName && merged.phone) {
      return withLang(finalizeDentalModify(biz, merged))
    }
    return withLang({
      text: !merged.guestName
        ? 'May I take your name for the callback?'
        : 'And a phone number so the team can call you back?',
      toolCalls: [{ tool: 'update_booking_fields', args: merged, result: 'modify fields' }],
      nextStep: 'modify_collect',
      bookingUpdates: merged,
      intent: 'modify',
    })
  }

  // Intent handlers (await_intent / completed / faq)
  switch (intent) {
    case 'emergency': {
      const severe = biz.emergency.severeAdvice || ''
      // After-hours closed line is only in the greeting — do not repeat it mid-call
      if (afterHours) {
        const lead = `I'm sorry you're in pain. I'll mark this as urgent and take your details. ${severe}`.trim()
        return withLang(startBookingCollect(biz, text, booking, afterHours, true, lead))
      }
      const lead = `I'm sorry you're in pain. ${biz.emergency.message} ${severe}`.trim()
      return withLang(startBookingCollect(biz, text, booking, afterHours, true, lead))
    }

    case 'new_patient': {
      const faq = matchDentalFaq(biz, text)
      const lead = faq
        ? `${faq} I can send a new-patient appointment request to the practice team.`
        : 'New patients are always welcome. I can send an appointment request to the practice team.'
      return withLang(
        startBookingCollect(biz, text, { ...booking, patientType: 'new' }, afterHours, false, lead),
      )
    }

    case 'existing_patient':
    case 'reservation': {
      return withLang(
        startBookingCollect(
          biz,
          text,
          booking,
          afterHours,
          false,
          `Of course — I'll take an ${getPresetForBusiness(biz).wording.bookingNoun} request for the practice team.`,
        ),
      )
    }

    case 'modify': {
      const name = parseName(text)
      const phone = parsePhone(text)
      const merged = {
        ...booking,
        guestName: name || booking.guestName,
        phone: phone || booking.phone,
        modifyRequest: text,
      }
      if (merged.guestName && merged.phone) {
        return withLang(finalizeDentalModify(biz, merged))
      }
      return withLang({
        text: "I can take a reschedule or cancel request and ask the team to call you back. What's your name and phone number?",
        toolCalls: [{ tool: 'detect_intent', args: { intent: 'modify' }, result: 'modify-as-callback' }],
        nextStep: 'modify_collect',
        bookingUpdates: merged,
        intent: 'modify',
      })
    }

    case 'membership': {
      return withLang({
        text: 'Membership plans start from £13.50 a month. Pay as you go is also available. Would you like me to ask the team to call you about joining?',
        toolCalls: [{ tool: 'detect_intent', args: { intent: 'membership' }, result: 'membership faq' }],
        nextStep: 'await_intent',
        bookingUpdates: {},
        intent: 'membership',
      })
    }

    case 'rates': {
      const known = findPricing(biz, text)
      if (known) {
        // Speak as full sentences (no bare "Item: price" lists)
        const spoken = /emergency/i.test(known)
          ? 'A same-day emergency appointment is £50 for the consultation, plus £10 for any X-rays, and treatment is charged on top. We aim to get you pain free at the appointment. Shall I take details for a same-day emergency request?'
          : /membership/i.test(known)
            ? 'Membership plans start from £13.50 a month. Pay as you go is also available. Would you like me to ask the team to call you about joining?'
            : `${known.replace(/:\s*/g, ' is ')}. Would you like me to take a message for the team?`
        return withLang({
          text: spoken,
          toolCalls: [{ tool: 'detect_intent', args: { intent: 'rates' }, result: known }],
          nextStep: 'await_intent',
          bookingUpdates: {},
          intent: 'rates',
        })
      }
      // Unverified treatment prices (crown, implant, Invisalign, etc.)
      return withLang(callbackUnknownPrice(biz, text.slice(0, 80), booking))
    }

    case 'nhs': {
      const faq = matchDentalFaq(biz, text)
      if (faq) {
        return withLang({
          text: faq,
          toolCalls: [{ tool: 'detect_intent', args: { intent: 'nhs' }, result: 'faq' }],
          nextStep: 'await_intent',
          bookingUpdates: {},
          intent: 'nhs',
        })
      }
      return withLang(callbackUnknownPrice(biz, 'NHS availability / treatment', booking))
    }

    case 'hours': {
      const sat = /saturday/i.test(text)
      const answer = sat ? saturdayHours(biz) : `${allHours(biz)}.`
      return withLang({
        text: answer,
        toolCalls: [{ tool: 'detect_intent', args: { intent: 'hours' }, result: 'hours' }],
        nextStep: 'await_intent',
        bookingUpdates: {},
        intent: 'hours',
      })
    }

    case 'location': {
      return withLang({
        text: locationBlurb(biz),
        toolCalls: [{ tool: 'detect_intent', args: { intent: 'location' }, result: 'location' }],
        nextStep: 'await_intent',
        bookingUpdates: {},
        intent: 'location',
      })
    }

    case 'nervous': {
      const faq =
        matchDentalFaq(biz, text) ||
        "That's completely understandable. Our team is used to nervous patients and people who haven't seen a dentist in a long time — we'll look after you at your pace."
      return withLang({
        text: `${faq} Would you like me to send an appointment request for you?`,
        toolCalls: [{ tool: 'detect_intent', args: { intent: 'nervous' }, result: 'reassure' }],
        nextStep: 'await_intent',
        bookingUpdates: {},
        intent: 'nervous',
      })
    }

    case 'confirm': {
      return withLang({
        text: `Lovely — I'll take an appointment request. May I have your full name?`,
        toolCalls: [{ tool: 'detect_intent', args: { intent: 'reservation' }, result: 'start collect' }],
        nextStep: 'collect_name',
        bookingUpdates: {},
        intent: 'reservation',
      })
    }

    case 'faq':
    default: {
      const faq = matchDentalFaq(biz, text)
      if (faq) {
        return withLang({
          text: faq,
          toolCalls: [{ tool: 'detect_intent', args: { intent: 'faq' }, result: 'faq hit' }],
          nextStep: 'await_intent',
          bookingUpdates: {},
          intent: 'faq',
        })
      }
      // Unknown medical / price / treatment → callback, no invention
      if (/\b(crown|implant|invisalign|brace|root\s*canal|veneer|whitening|nhs)\b/i.test(text)) {
        return withLang(callbackUnknownPrice(biz, text.slice(0, 80), booking))
      }
      return withLang({
        text: `I can help with appointments, emergencies, fees we publish, membership, opening hours, or our practices. Or I can take a message for the ${getPresetForBusiness(biz).wording.teamNoun}. What do you need?`,
        toolCalls: [{ tool: 'detect_intent', args: { intent: 'unknown' }, result: 'fallback' }],
        nextStep: 'await_intent',
        bookingUpdates: {},
        intent: 'unknown',
      })
    }
  }
}
