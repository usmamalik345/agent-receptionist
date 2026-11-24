/**
 * Booking agent (per vertical): fills slots, checks availability with tools, reads the
 * booking back and only writes it after the caller says yes on a LATER turn. The write
 * tool needs the confirmation id issued here; the orchestrator passes it to the tool
 * context only on a confirm_yes turn, so a booking can't be written without confirmation.
 */
import {
  matchOption, nightsBetween, addDays, parseDates, parseGuests, parseName, parseNights, parsePartOfDay, parsePhone, parseTime,
  ROOM_SYNONYMS, spokenDate, spokenTime, TREATMENT_SYNONYMS,
} from '../extract.ts'
import type { AgentReply, ToolCallRecord } from '../protocol.ts'
import type { Booking } from '../store.ts'
import { money, type Tenant } from '../tenant.ts'
import { callTool, type ToolContext } from '../tools.ts'

export interface BookingState {
  active: boolean
  treatment?: string
  location?: string
  date?: string
  time?: string
  partOfDay?: 'morning' | 'afternoon' | 'evening'
  checkIn?: string
  checkOut?: string
  guests?: number
  roomType?: string
  name?: string
  phone?: string
  offered?: string[]
  expecting?: 'treatment' | 'location' | 'date' | 'slot' | 'dates' | 'guests' | 'room' | 'name' | 'phone' | 'confirm'
  pending?: { id: string; args: Record<string, unknown>; summary: string }
  done?: Booking
}

export const emptyBooking = (): BookingState => ({ active: false })

const reply = (text: string, decision: string, grounding: string[] = [], extra: Partial<AgentReply> = {}): AgentReply => ({
  type: 'reply', agent: 'booking', text, source: 'template', grounding, citations: [], model: null, tokens: null, decision, ...extra,
})
const keyOf = (name: string) => name.split(/\s+/).find((w) => !/^(the|practice|clinic|road|street|surgery|dental)$/i.test(w)) ?? name
export const localToday = (tz: string, now: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)

function pickByPartOfDay(slots: string[], pod?: string): string[] {
  if (!pod) return slots
  const h = (s: string) => Number(s.slice(0, 2))
  const f = slots.filter((s) => (pod === 'morning' ? h(s) < 12 : pod === 'afternoon' ? h(s) >= 12 && h(s) < 17 : h(s) >= 17))
  return f.length ? f : slots
}

/** Pull every slot the caller gave this turn into the state (never overwrites with nothing). */
export function extractInto(s: BookingState, t: Tenant, text: string, today: string): void {
  const dates = parseDates(text, today)
  const time = parseTime(text)
  const name = parseName(text, s.expecting === 'name')
  const phone = parsePhone(text)
  if (name) s.name = name
  if (phone) s.phone = phone
  if (t.vertical === 'dental') {
    const tr = matchOption(text, t.dental!.treatments.map((x) => x.name), TREATMENT_SYNONYMS)
    if (tr) s.treatment = tr
    const loc = t.locations.find((l) => new RegExp(`\\b${keyOf(l.name)}\\b`, 'i').test(text))
    if (loc) s.location = loc.name
    else if (s.expecting === 'location' && /\b(first|either|any|don'?t mind|whichever)\b/i.test(text)) s.location = t.locations[0].name
    else if (s.expecting === 'location' && /\b(second|other|last)\b/i.test(text)) s.location = t.locations[t.locations.length - 1].name
    if (dates[0] && dates[0] !== s.date) { s.date = dates[0]; s.time = undefined; s.offered = undefined }
    const pod = parsePartOfDay(text)
    if (pod) s.partOfDay = pod
    if (time) s.time = time
    else if (s.offered?.length && /\b(first|earlier|earliest|that one|the first)\b/i.test(text)) s.time = s.offered[0]
    else if (s.offered && s.offered.length > 1 && /\b(second|later|latter|other one)\b/i.test(text)) s.time = s.offered[1]
  } else {
    if (dates[0]) s.checkIn = dates[0]
    if (dates[1]) s.checkOut = dates[1]
    const nights = parseNights(text)
    if (nights && s.checkIn && !dates[1]) s.checkOut = addDays(s.checkIn, nights)
    const g = parseGuests(text)
    if (g) s.guests = g
    const room = matchOption(text, t.hotel!.rooms.map((r) => r.type), ROOM_SYNONYMS)
    if (room) s.roomType = room
    else if (s.offered?.length && /\b(first|cheaper|cheapest|that one)\b/i.test(text)) s.roomType = s.offered[0]
    else if (s.offered && s.offered.length > 1 && /\b(second|other one|more expensive)\b/i.test(text)) s.roomType = s.offered[1]
  }
}

export interface BookingDeps {
  tenant: Tenant
  ctx: ToolContext
  tools: ToolCallRecord[]
  today: string
}

export async function runBookingAgent(d: BookingDeps, s: BookingState, text: string, intent: 'booking' | 'confirm_yes' | 'confirm_no'): Promise<AgentReply> {
  const t = d.tenant
  s.active = true
  const invoke = async <T>(name: string, args: Record<string, unknown>) => {
    const r = await callTool<T>('booking', name, args, d.ctx)
    d.tools.push(r.record)
    return r
  }

  if (intent === 'confirm_yes' && s.pending) {
    const tool = t.vertical === 'dental' ? 'book_appointment' : 'book_room'
    const r = await invoke<Booking>(tool, { ...s.pending.args, confirmation_id: s.pending.id })
    const summary = s.pending.summary
    s.pending = undefined
    if (!r.ok) {
      if (/unavailable/.test(r.error)) {
        s.time = undefined; s.roomType = undefined; s.offered = undefined
        return reply("Sorry, that's just been taken. Let me find you another option.", `${tool}:unavailable`, [], { escalate: undefined })
      }
      return reply("I'm sorry, I couldn't complete the booking just now. I'll pass you to the team so they can sort it out.", `${tool}:failed`, [], { escalate: { reason: `tool_failure:${tool}:${r.error}` } })
    }
    s.done = r.result
    s.active = false
    s.expecting = undefined
    return reply(`Lovely, you're all booked: ${summary}. We'll see you then. Is there anything else I can help with?`, `${tool}:ok`, [summary])
  }
  if (intent === 'confirm_no' && s.pending) {
    s.pending = undefined
    if (t.vertical === 'dental') { s.time = undefined; s.offered = undefined } else { s.roomType = undefined; s.offered = undefined }
    s.expecting = undefined
    return reply('No problem. What would you like to change?', 'confirm_no')
  }

  extractInto(s, t, text, d.today)
  return t.vertical === 'dental' ? dentalNext(d, s, invoke) : hotelNext(d, s, invoke)
}

type Invoke = <T>(name: string, args: Record<string, unknown>) => Promise<{ ok: true; result: T } | { ok: false; error: string }>

async function dentalNext(d: BookingDeps, s: BookingState, invoke: Invoke): Promise<AgentReply> {
  const t = d.tenant
  if (!s.treatment) {
    s.expecting = 'treatment'
    return reply("Sure. What's the appointment for: a check-up, a scale and polish, or something else?", 'ask_treatment')
  }
  if (!s.location) {
    if (t.locations.length === 1) s.location = t.locations[0].name
    else {
      s.expecting = 'location'
      return reply(`Which practice suits you better: ${t.locations.map((l) => l.name).join(' or ')}?`, 'ask_location')
    }
  }
  if (!s.date) {
    s.expecting = 'date'
    return reply('What day would suit you?', 'ask_date')
  }
  if (!s.time || !s.offered?.includes(s.time)) {
    const r = await invoke<string[]>('check_availability', { date: s.date, treatment: s.treatment, location: s.location })
    if (!r.ok) return reply("Sorry, I can't see the diary right now. I'll pass you to the team.", 'check_availability:failed', [], { escalate: { reason: `tool_failure:check_availability:${r.error}` } })
    const slots = r.result
    if (!slots.length) {
      const day = spokenDate(s.date)
      s.date = undefined; s.time = undefined; s.offered = undefined
      s.expecting = 'date'
      return reply(`Sorry, there's nothing free on ${day}. Is there another day that works?`, 'no_slots')
    }
    if (s.time && slots.includes(s.time)) s.offered = [s.time]
    else {
      const asked = s.time
      const opts = pickByPartOfDay(slots, s.partOfDay).slice(0, 2)
      s.offered = opts
      s.time = undefined
      s.expecting = 'slot'
      const lead = asked ? `${spokenTime(asked)} isn't free, but ` : ''
      return reply(`${lead}${lead ? 'on' : 'On'} ${spokenDate(s.date)} I have ${opts.map(spokenTime).join(' or ')}. Which suits you?`, 'offer_slots', opts.map(spokenTime))
    }
  }
  if (!s.name) {
    s.expecting = 'name'
    return reply("Great. Can I take your full name?", 'ask_name')
  }
  if (!s.phone) {
    s.expecting = 'phone'
    return reply(`Thanks, ${s.name.split(' ')[0]}. And the best number to reach you on?`, 'ask_phone')
  }
  const summary = `${article(s.treatment)} ${s.treatment.toLowerCase()} at ${s.location} on ${spokenDate(s.date)} at ${spokenTime(s.time!)}, for ${s.name}`
  s.pending = { id: globalThis.crypto.randomUUID(), summary, args: { date: s.date, time: s.time, treatment: s.treatment, location: s.location, name: s.name, phone: s.phone } }
  s.expecting = 'confirm'
  return reply(`Just to confirm, that's ${summary}. Shall I book it?`, 'confirm_request', [summary, s.phone])
}

async function hotelNext(d: BookingDeps, s: BookingState, invoke: Invoke): Promise<AgentReply> {
  const t = d.tenant
  if (!s.checkIn || !s.checkOut) {
    s.expecting = 'dates'
    if (s.checkIn) return reply(`And how many nights from ${spokenDate(s.checkIn)}?`, 'ask_checkout')
    return reply('Sure. What dates are you looking at?', 'ask_dates')
  }
  if (nightsBetween(s.checkIn, s.checkOut) < 1) {
    s.checkOut = undefined
    return reply('Sorry, the check-out date needs to be after check-in. How many nights would you like?', 'bad_dates')
  }
  if (!s.guests) {
    s.expecting = 'guests'
    return reply('And how many guests will there be?', 'ask_guests')
  }
  if (!s.roomType || !s.offered?.includes(s.roomType)) {
    const r = await invoke<Array<{ type: string; ratePerNight: number; nights: number; total: number }>>('check_room_availability', { check_in: s.checkIn, check_out: s.checkOut, guests: s.guests })
    if (!r.ok) return reply("Sorry, I can't see availability right now. I'll pass you to the team.", 'check_room_availability:failed', [], { escalate: { reason: `tool_failure:check_room_availability:${r.error}` } })
    const opts = r.result
    const nights = nightsBetween(s.checkIn, s.checkOut)
    if (!opts.length) {
      s.checkIn = undefined; s.checkOut = undefined; s.offered = undefined
      return reply(`Sorry, we're full for those dates for ${s.guests} guests. Would other dates work?`, 'no_rooms')
    }
    const wanted = s.roomType ? opts.find((o) => o.type === s.roomType) : undefined
    if (wanted) s.offered = [wanted.type]
    else {
      const top = opts.slice(0, 2)
      const asked = s.roomType
      s.offered = top.map((o) => o.type)
      s.roomType = undefined
      s.expecting = 'room'
      const lead = asked ? `The ${asked.toLowerCase()} isn't available then, but ` : ''
      const g = top.map((o) => `${o.type} at ${money(t, o.ratePerNight)} a night`)
      return reply(`${lead}${lead ? 'for' : 'For'} ${nights} night${nights > 1 ? 's' : ''} from ${spokenDate(s.checkIn)}, I have ${article(top[0].type)} ${g.join(', or a ')}. Which would you like?`, 'offer_rooms', g)
    }
  }
  if (!s.name) {
    s.expecting = 'name'
    return reply('Lovely. Can I take the name for the booking?', 'ask_name')
  }
  if (!s.phone) {
    s.expecting = 'phone'
    return reply(`Thanks, ${s.name.split(' ')[0]}. And a contact number?`, 'ask_phone')
  }
  const nights = nightsBetween(s.checkIn, s.checkOut)
  const room = t.hotel!.rooms.find((r) => r.type === s.roomType)!
  const total = money(t, room.ratePerNight * nights)
  const summary = `${article(s.roomType!)} ${s.roomType} for ${s.guests} guest${s.guests > 1 ? 's' : ''}, ${nights} night${nights > 1 ? 's' : ''} from ${spokenDate(s.checkIn)}, ${total} in total, under ${s.name}`
  s.pending = { id: globalThis.crypto.randomUUID(), summary, args: { check_in: s.checkIn, check_out: s.checkOut, room_type: s.roomType, guests: s.guests, name: s.name, phone: s.phone } }
  s.expecting = 'confirm'
  return reply(`Just to confirm, that's ${summary}. Shall I book it?`, 'confirm_request', [summary, s.phone, `${money(t, room.ratePerNight)} per night`])
}

const article = (w: string) => (/^[aeiou]/i.test(w) ? 'an' : 'a')

/** What to ask next, used after a side question during an active booking. */
export function resumePrompt(s: BookingState): string | null {
  if (!s.active || !s.expecting) return null
  const m: Record<NonNullable<BookingState['expecting']>, string> = {
    treatment: "Now, what's the appointment for?", location: 'Which practice would you like?', date: 'Now, what day would suit you?',
    slot: 'Which of those times would you like?', dates: 'Now, what dates are you looking at?', guests: 'And how many guests?',
    room: 'Which room would you like?', name: 'Can I take your name?', phone: 'And the best number for you?', confirm: 'Shall I go ahead and book it?',
  }
  return m[s.expecting]
}
