import { RESORT, ROOMS } from '../config/resort'
import { KNOWLEDGE, matchFaq } from '../config/knowledge'
import { getActiveBusiness, isDentalIndustry } from './businessRuntime'
import { dentalGreet, processDentalMessage } from './dentalEngine'
import { isFillerUtterance } from './fillers'
import type {
  BookingFields,
  ConversationStep,
  Intent,
  Language,
  Outcome,
} from './types'

export interface AgentReply {
  text: string
  toolCalls: Array<{ tool: string; args: Record<string, unknown>; result: string }>
  nextStep: ConversationStep
  bookingUpdates: Partial<BookingFields>
  intent?: Intent
  outcome?: Outcome
  escalate?: boolean
  createNotification?: { subject: string; body: string }
  /** Ops ticket without requiring full human transfer */
  createTicket?: {
    reason: string
    summary: string
    priority: 'normal' | 'high' | 'urgent'
  }
  end?: boolean
}

const COLLECT_STEPS: ConversationStep[] = [
  'collect_check_in',
  'collect_check_out',
  'collect_rooms',
  'collect_room_type',
  'collect_guests',
  'collect_name',
  'collect_phone',
  'collect_special',
  'confirm_summary',
  'dining_details',
  'complaint_details',
  'modify_collect',
]

function fmtDate(iso: string, lang: Language = 'en'): string {
  if (!iso) return '-'
  try {
    const d = new Date(iso + 'T12:00:00')
    return d.toLocaleDateString(lang === 'ar' ? 'ar-AE' : 'en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    })
  } catch {
    return iso
  }
}

/** Detect Arabic script vs English; also honour explicit switch phrases. */
export function detectLanguage(text: string, fallback: Language): Language {
  if (/english\s*please|speak\s*english|بالإنجليز|انجليزي/i.test(text)) return 'en'
  if (/arabic\s*please|speak\s*arabic|بالعربي|عربي\s*من\s*فضلك|بالعربية/i.test(text)) return 'ar'
  const arabicChars = (text.match(/[\u0600-\u06FF]/g) || []).length
  const latinChars = (text.match(/[A-Za-z]/g) || []).length
  if (arabicChars >= 3 && arabicChars > latinChars) return 'ar'
  if (latinChars >= 3 && latinChars > arabicChars) return 'en'
  return fallback
}

function isShortConfirm(text: string): boolean {
  const t = text.toLowerCase().trim()
  if (t.length > 48) return false
  if (/\b(booking|reservation|availability|available|room|check[\s-]?in)\b/i.test(t)) return false
  return (
    /^(yes|yeah|yep|yup|correct|confirm|that's right|that is right|ok|okay|please proceed|go ahead|sure|absolutely|perfect|yes please|ok please)[.!]?$/i.test(
      t,
    ) || /^(نعم|أجل|ايوه|أيوه|تمام|أكد|موافق|صح|حسناً|حسنا|طيب)[.!]?$/.test(text.trim())
  )
}

/** Guest wants to hang up / end: EN + common Urdu/Hinglish (“band karna”). */
export function isGoodbyePhrase(text: string): boolean {
  const t = text.toLowerCase().trim().replace(/[.…!]+$/g, '')
  if (t.length > 64) return false
  if (
    /^(no thanks|no thank you|nothing else|that'?s (all|it)|i'?m good|im good|all good|bye|goodbye|good bye|hang up|end (the )?(call|chat|conversation)|we'?re done|done for now|finish|nope that'?s all)\b/i.test(
      t,
    )
  ) {
    return true
  }
  // Upsell decline when not mid-collect (“none” alone)
  if (/^(none|no more|nothing|لا شكرا|لا شكراً|شكرا|شكراً|خلاص|مع السلامة)\s*$/i.test(t)) return true
  // Urdu / Hinglish hang-up
  if (/\b(band\s*kar(?:na|o|do)?|call\s*band|setting\s*band|khatam|bas\s*karo)\b/i.test(t)) return true
  if (/^(مع السلامة|وداعا|أنهى المكالمة|انهي المكالمة)\b/.test(text.trim())) return true
  return false
}

function goodbyeReply(language: Language, booking: BookingFields): AgentReply {
  const biz = getActiveBusiness()
  const name = booking.guestName ? `, ${booking.guestName}` : ''
  const team =
    biz.industry === 'hotel'
      ? language === 'ar'
        ? 'فريق الحجوزات'
        : 'Our reservations team'
      : 'The practice team'
  return {
    text:
      language === 'ar'
        ? `شكراً لاتصالكم بـ ${biz.greetingName}${name}. سيتابع ${team} معكم عند الحاجة. مع السلامة.`
        : `Thank you for calling ${biz.greetingName}${name}. ${team} will follow up if needed. Goodbye.`,
    toolCalls: [{ tool: 'end_conversation', args: { reason: 'guest_goodbye' }, result: 'Call ended' }],
    nextStep: 'completed',
    bookingUpdates: {},
    intent: 'goodbye',
    end: true,
  }
}

function isGuestCountPhrase(text: string): boolean {
  const t = text.toLowerCase()
  return (
    /\b(\d+)\s*(people|persons?|guests?|adults?|pax|kids?|children)\b/.test(t) ||
    /\b(\d+)\s*adults?\s*(and|&|,)?\s*(\d+)?\s*(kids?|children|child)?\b/.test(t) ||
    /\bfamily\s+of\s+\d+\b/.test(t) ||
    /\b(\d+|one|two|three|four|a|an)\s+couples?\b/.test(t) ||
    /\b(\d+|one|two|three)\s+famil(?:y|ies)\b/.test(t) ||
    /\b(for\s+two|a\s+couple|couple|two\s+people|two\s+adults|just\s+(us|two))\b/.test(t) ||
    /شخصين|بالغين|شخصان|أسرة|عائلة\s*من|أزواج|زوجين/.test(text)
  )
}

const PARTY_WORD_NUM: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
}

function partyWordOrDigit(raw: string): number {
  const s = raw.toLowerCase()
  if (/^\d+$/.test(s)) return parseInt(s, 10)
  return PARTY_WORD_NUM[s] ?? 0
}

/**
 * Hotel party shapes: 2 couples → 2 couple rooms; couple + family with kids; large mixed groups.
 */
export function parsePartyComposition(text: string): {
  adults: number | null
  children: number | null
  rooms: number | null
  note: string | null
} {
  const t = text.toLowerCase()
  if (!/\b(couple|couples|family|families|famil)\b/i.test(t) && !/أزواج|زوجين|عائلة|أسر/.test(text)) {
    return { adults: null, children: null, rooms: null, note: null }
  }

  const notes: string[] = []
  let adults = 0
  let children = 0
  let roomSlots = 0
  let hit = false
  let childrenKnown = false

  // "2 couple rooms" / "two rooms for couples"
  const coupleRoomsOnly = t.match(/\b(\d+|one|two|three|four)\s+couple\s+rooms?\b/)
  if (coupleRoomsOnly) {
    const n = partyWordOrDigit(coupleRoomsOnly[1])
    if (n > 0) {
      hit = true
      adults += n * 2
      roomSlots += n
      notes.push(`${n} couple room${n === 1 ? '' : 's'} (1 room per couple)`)
    }
  }

  // N couples (skip if already counted via "N couple rooms")
  if (!coupleRoomsOnly) {
    const couplesM = t.match(/\b(\d+|one|two|three|four|five|a|an)\s+couples?\b/)
    let coupleCount = 0
    if (couplesM) {
      coupleCount = partyWordOrDigit(couplesM[1])
    } else if (/\bcouples?\b/.test(t)) {
      // "a couple", "couple with kids", "couple and a family"
      coupleCount = 1
    }
    if (coupleCount > 0) {
      hit = true
      adults += coupleCount * 2
      roomSlots += coupleCount
      notes.push(
        coupleCount === 1
          ? '1 couple room'
          : `${coupleCount} couple rooms (1 room per couple)`,
      )
    }
  }

  // Families: "2 families", "a family of 4", "family with 2 children"
  let familyUnits = 0
  let familyAdults = 0
  let familyChildren = 0

  const familiesCountM = t.match(/\b(\d+|one|two|three|four)\s+famil(?:y|ies)\b/)
  if (familiesCountM) {
    familyUnits = partyWordOrDigit(familiesCountM[1])
  } else if (
    /\b(?:a|the|one)\s+family\b/.test(t) ||
    /\b(?:and|with|plus)\s+(?:a\s+|the\s+|one\s+)?famil(?:y|ies)\b/.test(t)
  ) {
    familyUnits = 1
  }

  // "family of N": N is total people in that family (usually 2 adults + rest children)
  const familyOfMatches = [...t.matchAll(/\bfamily\s+of\s+(\d+)\b/g)]
  if (familyOfMatches.length) {
    hit = true
    if (!familyUnits) familyUnits = familyOfMatches.length
    for (const m of familyOfMatches) {
      const n = parseInt(m[1], 10)
      if (n >= 2) {
        familyAdults += 2
        familyChildren += Math.max(0, n - 2)
        childrenKnown = true
      } else {
        familyAdults += n
      }
    }
  }

  // "family with 2 children" / "families with a child"
  const familyWithKids = [...t.matchAll(/\bfamil(?:y|ies)\s+with\s+(\d+|a|one|two|three|four)\s+(?:kids?|children|child)\b/g)]
  if (familyWithKids.length) {
    hit = true
    childrenKnown = true
    if (!familyUnits) familyUnits = familyWithKids.length
    for (const m of familyWithKids) {
      const kids = partyWordOrDigit(m[1])
      familyAdults += 2 // assume 2 parents unless adults already stated for family
      familyChildren += kids
    }
  }

  // Bare "family" / "families" with unit count but no of/with: assume 2 adults per family, kids TBD
  if (familyUnits > 0 && familyAdults === 0 && familyOfMatches.length === 0 && familyWithKids.length === 0) {
    hit = true
    familyAdults = familyUnits * 2
    notes.push(
      familyUnits === 1
        ? '1 family room: confirm children count if any'
        : `${familyUnits} family rooms: confirm children count if any`,
    )
  } else if (familyUnits > 0) {
    hit = true
    notes.push(
      familyUnits === 1
        ? '1 family room'
        : `${familyUnits} family rooms`,
    )
  }

  if (familyUnits > 0 || familyAdults > 0) {
    adults += familyAdults
    children += familyChildren
    roomSlots += familyUnits > 0 ? familyUnits : familyAdults > 0 ? 1 : 0
  }

  // Explicit kids on top of couple (not already in family-with): "2 couples and 3 children" is rare;
  // "1 couple and 2 children" → kids share couple room unless separate rooms asked
  if (/\bcouple/.test(t) && !familyWithKids.length && !familyOfMatches.length) {
    const extraKids =
      t.match(/\band\s+(\d+|a|one|two|three)\s+(?:kids?|children|child)\b/) ||
      t.match(/\bwith\s+(\d+|a|one|two|three)\s+(?:kids?|children|child)\b/)
    if (extraKids && !/\bfamily\b/.test(t)) {
      const k = partyWordOrDigit(extraKids[1])
      children += k
      childrenKnown = true
      // Default: same room unless separate layout also said
      if (!/\bseparate\b|\broom\s+for\s+(?:the\s+)?(?:kids|children)/.test(t)) {
        notes.push('Children with the couple unless separate kids room requested')
      }
    }
  }

  if (!hit) {
    return { adults: null, children: null, rooms: null, note: null }
  }

  // Mixed large party without clear slots: at least ceil(adults/2) rooms as soft hint
  let rooms: number | null = roomSlots > 0 ? roomSlots : null
  if (rooms == null && adults >= 4) {
    rooms = Math.ceil(adults / 2)
    notes.push(`Suggested ${rooms} rooms for ${adults} adults: confirm layout`)
  }

  // Couple + separate kids room request → don't lock to 1 couple room only
  if (
    rooms === 1 &&
    /\b(separate|kids? room|room\s+for\s+(?:the\s+)?(?:kids|children)|one\s+for\s+(?:the\s+)?(?:kids|children))\b/.test(t)
  ) {
    rooms = 2
  }

  const mentionsKids = /\b(child|kids|children|infant|toddler|baby)\b/.test(t)
  const coupleOnly = roomSlots > 0 && familyUnits === 0 && !mentionsKids

  // Deduplicate notes
  const uniq = [...new Set(notes)]
  return {
    adults: adults > 0 ? adults : null,
    children: childrenKnown ? children : children > 0 ? children : coupleOnly ? 0 : mentionsKids ? null : null,
    rooms,
    note: uniq.length ? uniq.join('; ') : null,
  }
}

function isIncompleteBookingLead(text: string): boolean {
  const t = text.toLowerCase().trim().replace(/[.…]+$/, '')
  if (t.length > 60) return false
  // Guest still mid-sentence: "I need reservation for…" / bare "I just need"
  if (/\b(reservation|booking)\s+for\s*$/i.test(t)) return true
  if (/^(reservation|booking)(\s+for)?$/i.test(t)) return true
  if (/^(i\s+)?(just\s+)?(need|want|looking for|would like)$/i.test(t)) return true
  if (/^(i\s+)?(just\s+)?(need|want|would like)\s+(a|an|to|for|some)?$/i.test(t)) return true
  if (/^(i\s+)?(just\s+)?(need|want|would like)\s+(a\s+)?(reservation|booking)\s+for$/i.test(t)) {
    return true
  }
  // "want a room" / "need a villa" are complete enough: not incomplete leads
  return false
}

export function isRoomTypeQuestion(text: string): boolean {
  const t = text.toLowerCase()
  return (
    /\b(what|which)\s+(type(s)?\s+of\s+)?rooms?\b/.test(t) ||
    /\broom\s+types?\b/.test(t) ||
    /\bwhat\s+rooms?\s+(do\s+you\s+have|available)\b/.test(t) ||
    /\b(types?|categories)\s+of\s+(rooms?|suites?|villas?)\b/.test(t) ||
    /\b(do\s+you\s+have|any)\s+(deluxe|suite|villa|family)\s+rooms?\b/.test(t) ||
    /أنواع\s*الغرف|ما\s*أنواع|غرفكم|أنواع الإقامة/.test(text)
  )
}

export function formatRoomTypeMenu(lang: Language): string {
  const lines = ROOMS.choices.map((c) => `${c.id}) ${c.name} (${c.size}): ${c.short}`)
  if (lang === 'ar') {
    return (
      'من موقع إرث، هذه أبرز فئات الإقامة (التوفر يُؤكد مع الحجوزات):\n' +
      lines.join('\n') +
      '\n\nاختاروا رقماً (مثلاً 1 أو 4)، أو قولوا اسم الفئة.'
    )
  }
  return (
    'From erth.ae, here are our main stay types (availability confirmed by reservations):\n' +
    lines.join('\n') +
    '\n\nReply with a number (e.g. 1 or 4), or say the name: for example “Al Muradi” or “pool villa”.'
  )
}

export function parseRoomTypeChoice(text: string): string | null {
  const t = text.toLowerCase().trim()
  const numMatch =
    t.match(/^\s*(?:#|number|option|choice)?\s*(\d{1,2})\s*[.)]?\s*$/i) ||
    t.match(/\b(?:number|option|choice)\s*(\d{1,2})\b/i) ||
    t.match(/\b(?:take|choose|pick|go with|want)\s+(?:number\s+)?(\d{1,2})\b/i)
  if (numMatch) {
    const n = parseInt(numMatch[1], 10)
    const hit = ROOMS.choices.find((c) => c.id === n)
    if (hit) return hit.name
  }
  // Name / keyword match
  const aliases: Array<{ re: RegExp; name: string }> = [
    { re: /ubayya|facilities\s*view/i, name: 'Al Ubayya Deluxe Room' },
    { re: /hadiqa|garden\s*deluxe/i, name: 'Al Hadiqa Deluxe Room' },
    { re: /minhaf|executive\s*suite/i, name: 'Minhaf Executive Suite' },
    { re: /muradi|family\s*suite|bunk/i, name: 'Al Muradi Family Suite' },
    { re: /\berth\s*suite\b/i, name: 'Erth Suite' },
    { re: /rabdan/i, name: 'Rabdan Suite' },
    { re: /hidra/i, name: 'Al Hidra Suite' },
    { re: /beach\s*villa|one[\s-]?bedroom\s*beach/i, name: 'One-Bedroom Beach Villa' },
    { re: /three[\s-]?bedroom|3[\s-]?bedroom|erth\s*villa/i, name: 'Erth Three-Bedroom Pool Villa' },
    { re: /two[\s-]?bedroom\s*pool|2[\s-]?bedroom\s*pool/i, name: 'Two-Bedroom Pool Villa' },
    { re: /pool\s*villa|one[\s-]?bedroom\s*pool/i, name: 'One-Bedroom Pool Villa' },
    { re: /\bdeluxe\b/i, name: 'Al Ubayya Deluxe Room' },
    { re: /\bsuite\b/i, name: 'Minhaf Executive Suite' },
    { re: /\bvilla\b/i, name: 'One-Bedroom Pool Villa' },
  ]
  for (const a of aliases) {
    if (a.re.test(text)) return a.name
  }
  for (const c of ROOMS.choices) {
    if (t.includes(c.name.toLowerCase())) return c.name
  }
  return null
}

function roomTypeReply(language: Language): AgentReply {
  return {
    text: formatRoomTypeMenu(language),
    toolCalls: [{ tool: 'list_room_types', args: { source: 'erth.ae/accommodations' }, result: 'room menu shown' }],
    nextStep: 'collect_room_type',
    bookingUpdates: {},
    intent: 'reservation',
  }
}

function parseRoomNumber(text: string): string | null {
  const m =
    text.match(/\broom\s*(?:number|no\.?|#)?\s*(\d{2,4})\b/i) ||
    text.match(/\b(?:in|at)\s+(\d{3,4})\b/i) ||
    text.match(/\b(\d{3,4})\b/)
  return m ? m[1] : null
}

function classifyServiceIssue(text: string): { dept: string; label: string } {
  const t = text.toLowerCase()
  if (/\b(ac|a\/c|air\s*cond|heating|hvac|مكيف|تكييف)\b/.test(t)) {
    return { dept: 'ENG', label: 'Air conditioning / HVAC' }
  }
  if (/\b(leak|drain|shower|toilet|plumb|water|تسريب|صرف|دش)\b/.test(t)) {
    return { dept: 'ENG', label: 'Plumbing / leak' }
  }
  if (/\b(minibar|empty|restock|ثلاجة|ميني\s*بار)\b/.test(t)) {
    return { dept: 'HK', label: 'Minibar / amenities restock' }
  }
  if (/\b(luggage|bag|suitcase|حقيبة|أمتعة)\b/.test(t)) {
    return { dept: 'Bell', label: 'Luggage delay' }
  }
  if (/\b(noise|noisy|loud|party|ضوضاء|إزعاج)\b/.test(t)) {
    return { dept: 'FO', label: 'Noise complaint' }
  }
  if (/\b(dirty|housekeep|towel|sheet|نظاف|خادمة)\b/.test(t)) {
    return { dept: 'HK', label: 'Housekeeping' }
  }
  return { dept: 'FO', label: 'Guest service issue' }
}

function isActionableComplaint(text: string): boolean {
  const t = text.toLowerCase()
  if (text.trim().length < 8) return false
  return (
    /\b(ac|a\/c|air\s*cond|broken|not working|leak|drain|noise|dirty|minibar|empty|luggage|forgot|shower|toilet|maintenance|repair|مكيف|تسريب|ضوضاء)\b/i.test(
      t,
    ) ||
    (text.length > 28 &&
      /\b(room|problem|issue|complaint|help|urgent|غرفة|مشكلة|شكوى)\b/i.test(t))
  )
}

export function formatUpsellMenu(lang: Language): string {
  if (lang === 'ar') {
    return 'هل تريدون تسجيل إضافة؟ ١) وصول مبكر  ٢) فطور  ٣) مغادرة متأخرة: أو قولوا «لا».'
  }
  return 'Want me to note an add-on for reservations? Reply 1) early check-in  2) breakfast  3) late check-out: or say “none”.'
}

export function parseUpsellSelection(text: string): string | null {
  const t = text.toLowerCase().trim()
  if (/^(none|no|nope|لا|بدون)\b/.test(t)) return null
  // Bare 1 / 2 / 3 only (short replies after upsell menu): not “1 couple…”
  if (/^(1|one|#\s*1)\s*[.)]?\s*$/.test(t) || /\bearly\s*check[\s-]?in\b/.test(t)) {
    return 'Guest requests early check-in (subject to availability)'
  }
  if (/^(2|two|#\s*2)\s*[.)]?\s*$/.test(t) || /\b(add|include|want|need)\s+breakfast\b/.test(t) || /\bbreakfast\s+please\b/.test(t)) {
    return 'Guest requests breakfast add-on / confirm if included in rate'
  }
  if (/^(3|three|#\s*3)\s*[.)]?\s*$/.test(t) || /\blate\s*check[\s-]?out\b/.test(t)) {
    return 'Guest requests late check-out (may carry a fee; subject to occupancy)'
  }
  return null
}

function isUpsellMenuAsk(text: string): boolean {
  return /\b(add[- ]?ons?|upsell|extras?|what can i add|any upgrades?|early check|late check.?out|add breakfast)\b/i.test(
    text,
  )
}

function buildComplaintResolution(
  text: string,
  language: Language,
  booking: BookingFields,
): AgentReply {
  const name = parseName(text) || booking.guestName || ''
  const phone = parsePhone(text) || booking.phone || ''
  const room = parseRoomNumber(text)
  const issue = classifyServiceIssue(text)
  const label = name || 'Guest'
  const roomBit = room ? `Room ${room}` : 'Room not stated'
  const eta =
    issue.dept === 'ENG'
      ? language === 'ar'
        ? 'سأطلب من الهندسة التواصل خلال نحو ٢٠ دقيقة.'
        : 'I’ve asked engineering to respond: typical target about 20 minutes when on-site.'
      : language === 'ar'
        ? 'سأُشعر الاستقبال للمتابعة فوراً.'
        : 'I’ve flagged the front desk to follow up immediately.'

  const subject = `PRIORITY ${issue.dept}: ${issue.label}: ${roomBit}: ${label}`
  const body = [
    `PRIORITY ${issue.dept} ticket`,
    issue.label,
    roomBit,
    `Guest: ${label}`,
    `Phone: ${phone || 'not provided'}`,
    `Details: ${text.trim()}`,
    issue.dept === 'ENG' ? 'Action: dispatch engineering / call guest with ETA.' : 'Action: resolve and call guest back.',
  ].join(' · ')

  const reason = `${issue.dept} · ${issue.label}${room ? ` · Rm ${room}` : ''}`

  return {
    text:
      language === 'ar'
        ? `أعتذر بصدق عن الإزعاج${room ? ` في الغرفة ${room}` : ''}. سجّلت تذكرة ${issue.dept} بأولوية عالية وأشعرت المكتب. ${eta} هل تريدون أيضاً التحدث مع زميل الآن؟`
        : `I’m truly sorry${room ? ` about the issue in room ${room}` : ''}. I’ve opened a priority ${issue.dept} ticket for ${issue.label.toLowerCase()} and notified the desk. ${eta} Would you also like to speak with a colleague now?`,
    toolCalls: [
      { tool: 'detect_intent', args: { intent: 'complaint', dept: issue.dept, room }, result: 'priority ticket logged' },
      { tool: 'create_desk_notification', args: { subject, body, priority: 'high' }, result: 'Desk WhatsApp/ops notified' },
      { tool: 'escalate_to_human', args: { reason }, result: 'Staff ticket created' },
    ],
    nextStep: 'await_intent',
    bookingUpdates: {
      specialRequests: [booking.specialRequests, `${issue.dept}: ${text.trim()}`].filter(Boolean).join('; '),
      guestName: name || booking.guestName,
      phone: phone || booking.phone,
    },
    intent: 'complaint',
    outcome: 'callback_requested',
    createNotification: { subject, body },
    createTicket: {
      reason,
      summary: text.trim().slice(0, 160),
      priority: 'high',
    },
    escalate: true,
  }
}

function isArabicGreeting(text: string): boolean {
  const t = text.trim()
  return (
    /^(السلام\s*عليكم|سلام\s*عليكم|مرحباً?|أهلاً?|اهلا|هلا)([\s!.،؟]*| كيف.*)?$/u.test(t) ||
    (/^(السلام\s*عليكم|مرحباً?|أهلاً?)/u.test(t) && t.length < 48 && !/سعر|حجز|غرفة|مطار/.test(t))
  )
}

function isOtaOrExistingBooking(text: string): boolean {
  return /\b(booking\.com|expedia|agoda|hotels\.com|ota|already paid|paid (already|online|on)|existing (booking|reservation)|confirm.*(existing|paid|ota)|i (already )?booked|pre[\s-]?paid|voucher)\b/i.test(
    text,
  )
}

function faqAnswerOnly(text: string, language: Language): string {
  const key = matchFaq(text)
  if (key) return KNOWLEDGE[key][language]
  if (/\bspa\b|سبا/i.test(text)) return KNOWLEDGE.spa[language]
  if (/\bdining|restaurant|مطعم/i.test(text)) return KNOWLEDGE.dining[language]
  return faqReply(text, language).replace(/\s*May I help with anything else.*$/i, '').replace(/\s*هل يمكنني مساعدتكم.*$/u, '')
}

function isRoomsOnlyPhrase(text: string): boolean {
  const t = text.toLowerCase().trim()
  if (isGuestCountPhrase(text)) return false
  return (
    /\b(\d+)\s*rooms?\b/.test(t) ||
    /\b(one|1|just\s+one|single)\s*rooms?\b/.test(t) ||
    /^(one|just one|1)$/.test(t) ||
    /غرفة واحدة|غرفتين|\d+\s*غرف/.test(text)
  )
}

function isSpecialRequestPhrase(text: string): boolean {
  return /\b(late\s*check[\s-]?in|arriving\s+late|check[\s-]?in\s+at|check\s+in\s+after|connecting|accessible|quiet\s+room|high\s*floor|extra\s*bed|crib|arrival\s+at)\b|وصول\s*متأخر|تسجيل\s*وصول\s*متأخر/i.test(
    text,
  )
}

function isEmptySpecialConfirm(text: string): boolean {
  const t = text.trim()
  return (
    /^(yes|yeah|yep|yup|ok|okay|none|no|nothing|nope|n\/a|na|-)(\s+please)?[.!]*$/i.test(t) ||
    /^(نعم|لا|لا شيء|بدون|لا يوجد|تمام|حسناً?|طيب)(\s+من\s+فضلك)?[.!]*$/u.test(t)
  )
}

function normalizeSpecialRequest(text: string): string {
  if (/late\s*check|arriving\s+late|check[\s-]?in\s+at|بعد\s*منتصف|وصول\s*متأخر/i.test(text)) {
    const time = parseTime(text)
    if (time) return `Late check-in around ${time}`
    if (/1\s*a\.?m|01:00|1am/i.test(text)) return 'Late check-in around 01:00'
    return text.trim().length < 100 ? text.trim() : 'Late check-in'
  }
  return text.trim()
}

/**
 * DEMO only: when a guest says “National Day weekend” without dates, map to a fixed
 * inquiry window near UAE National Day (2–3 Dec). Not live inventory; still subject to confirmation.
 */
const DEMO_NATIONAL_DAY_WEEKEND_START = '2026-12-02'

function nextMissingStep(b: BookingFields): ConversationStep {
  if (!b.checkIn) return 'collect_check_in'
  if (!b.checkOut) return 'collect_check_out'
  if (b.rooms == null) return 'collect_rooms'
  if (b.adults == null) return 'collect_guests'
  if (!b.guestName?.trim()) return 'collect_name'
  if (!b.phone?.trim()) return 'collect_phone'
  return 'collect_special'
}

function askForMissingStep(step: ConversationStep, language: Language): string {
  return stepPrompt(step, language).trim() || (language === 'ar' ? 'كيف أتابع؟' : 'How shall I continue?')
}

function advanceBookingReply(
  language: Language,
  booking: BookingFields,
  patch: Partial<BookingFields>,
  prefix: string,
): AgentReply {
  const merged: BookingFields = {
    ...booking,
    ...patch,
    rooms: patch.rooms !== undefined ? patch.rooms : booking.rooms,
    adults: patch.adults !== undefined ? patch.adults : booking.adults,
    children: patch.children !== undefined ? patch.children : booking.children,
    language,
  }
  const next = nextMissingStep(merged)
  if (next === 'collect_special' && (merged.specialRequests || '').trim()) {
    return {
      text: (prefix ? prefix + ' ' : '') + buildConfirmText(merged, language),
      toolCalls: [
        { tool: 'update_booking_fields', args: patch as Record<string, unknown>, result: 'fields set' },
        {
          tool: 'confirm_booking_summary',
          args: { summary: buildBookingSummary(merged) },
          result: 'Awaiting confirmation',
        },
      ],
      nextStep: 'confirm_summary',
      bookingUpdates: patch,
      intent: 'reservation',
    }
  }
  return {
    text: (prefix ? prefix + ' ' : '') + askForMissingStep(next, language),
    toolCalls: [{ tool: 'update_booking_fields', args: patch as Record<string, unknown>, result: 'fields set' }],
    nextStep: next,
    bookingUpdates: patch,
    intent: 'reservation',
  }
}

/** True when the utterance dumps multiple booking fields at once. */
function isMultiFieldDump(text: string): boolean {
  const u = extractRichReservation(text)
  let n = 0
  if (u.checkIn) n++
  if (u.checkOut) n++
  if (u.adults != null) n++
  if (u.guestName) n++
  if (u.phone) n++
  return n >= 2
}

function isStartInquiryPhrase(text: string): boolean {
  const t = text.toLowerCase().trim()
  return (
    /\b(start|take|begin|open)\s+(an?\s+|the\s+)?(inquir(?:y|ies)|enquir(?:y|ies)|booking)\b/i.test(t) ||
    /\b(take\s+(an?\s+|the\s+)?(inquir(?:y|ies)|enquir(?:y|ies)))\b/i.test(t) ||
    /\bok[,.]?\s*(book|take|start)\b/i.test(t) ||
    /\byes[,.]?\s*(book|take|start)\b/i.test(t)
  )
}

function isQuickQuestionLead(text: string): boolean {
  const t = text.toLowerCase().trim()
  return /^(quick question|a quick question|i have a question|just a question|question please|ask (you )?something)\b/i.test(
    t,
  )
}

function hasStayWords(text: string): boolean {
  return (
    /\b(rooms?|stay|nights?|check[\s-]?in|villa|suite|accommodation|hotel\s+room)\b/i.test(text) ||
    /غرفة|إقامة|ليال/.test(text)
  )
}

/** Restaurant / table request without a room stay. */
function isDiningWithoutStay(text: string): boolean {
  const t = text.toLowerCase()
  const diningCue =
    /\b(table|dinner|lunch|restaurant|book a table|eat)\b/.test(t) || /مطعم|عشاء|غداء|طاولة/.test(text)
  return diningCue && !hasStayWords(text)
}

/** Relative date only (tomorrow/tonight) with no stay / dining cues — do not open a booking. */
function isRelativeDateOnlyWithoutStay(text: string): boolean {
  const t = text.toLowerCase().trim()
  const hasRel =
    /\b(tomorrow|tonight|today|day after tomorrow)\b/.test(t) || /غداً?|بكره|بكرا|اليوم/.test(text)
  if (!hasRel || hasStayWords(text) || isDiningWithoutStay(text)) return false
  if (/\b(book|reserv|adult|guest|villa|suite|accommodation|hotel)\b/.test(t)) return false
  const stripped = t
    .replace(/\b(tomorrow|tonight|today|day after tomorrow|please|pls|um+|uh+|for|a|an|the)\b/g, '')
    .replace(/[^\w\s]/g, '')
    .trim()
  return stripped.length < 12
}

function isOffTopicChatter(text: string): boolean {
  const t = text.toLowerCase()
  return (
    /\b(poem|poetry|limerick|haiku|football|soccer|match score|latest news|tell me a joke|riddle)\b/.test(t) ||
    /\b(write|compose|make)\s+(me\s+)?(a\s+)?poem\b/.test(t) ||
    /\bpoem\s+about\b/.test(t) ||
    /قصيدة|كرة\s*قدم|أخبار/.test(text)
  )
}

function isSimpleGreetingOnly(text: string): boolean {
  const t = text.trim()
  return /^(hi|hello|hey|good\s+(morning|afternoon|evening)|salam|marhaba|assalamu\s+alaikum)([\s!,.]*)$/i.test(
    t,
  )
}

const OFF_TOPIC_REPLY =
  "I'm the Erth Abu Dhabi reservations assistant, so I can help with stays, dining, spa, facilities, or connect you to a colleague."

function isNewReservationUtterance(text: string): boolean {
  if (isDiningWithoutStay(text) || isRelativeDateOnlyWithoutStay(text) || isOffTopicChatter(text)) {
    return false
  }
  const t = text.toLowerCase()
  return (
    isStartInquiryPhrase(text) ||
    /\b(book\s+(a\s+)?rooms?|want\s+(a\s+)?room|need\s+(a\s+)?room|new\s+(booking|reservation)|reserve\s+(a\s+)?room|i\s+want\s+(a\s+)?room|check[\s-]?in\s+\d)/i.test(
      t,
    ) ||
    /\b((i('d| would)?\s+)?(like|want|need)\s+to\s+book)\b/i.test(t) ||
    (/\bbook(\s+please|\s+pls)?\b/i.test(t) && hasStayWords(text)) ||
    (/\b(book|reserv)/i.test(t) && /\b(room|adult|check[\s-]?in|night)\b/i.test(t)) ||
    /أريد\s*(أن\s*)?أحجز|أريد\s*غرفة|حجز\s*غرفة/.test(text)
  )
}

/** Vague / clear book-start phrases imply 1 room unless an explicit count is given. */
function impliesSingleRoomBooking(text: string): boolean {
  if (isOtaOrExistingBooking(text)) return false
  if (
    /\b(modif|cancel\b|change.*(booking|reservation)|how much|per night|spa hours|airport|parking|dubai marina)\b/i.test(
      text,
    )
  ) {
    return false
  }
  // Explicit multi-room count is handled separately: do not force 1 here
  if (/\b([2-9]|\d{2,})\s*rooms?\b/i.test(text)) return false

  return (
    /\b(a room|room pls|one room|want a room|need a room|book a room)\b/i.test(text) ||
    /\bbook\s+rooms?\b/i.test(text) ||
    /\bbook(\s+please|\s+pls)?\b/i.test(text) ||
    /\b((i('d| would)?\s+)?(like|want|need)\s+to\s+book)\b/i.test(text) ||
    /\b(i want to book|i'd like to book|id like to book|book room please|book rooms please)\b/i.test(text) ||
    /أريد\s*(أن\s*)?أحجز|حجز\s*غرفة|غرفة\s*من\s*فضلك/.test(text)
  )
}

function isAvailabilityOrConfirmNow(text: string): boolean {
  return /\b(availability|available|confirm\s+(my\s+)?(booking|reservation)|book(ing)?\s+now|do you have (a\s+)?room)\b/i.test(
    text,
  )
}

export function detectIntent(text: string): Intent {
  const t = text.toLowerCase().trim()

  if (isArabicGreeting(text)) {
    return 'faq' // handled specially as greeting: not rates
  }

  if (
    /\b(agent|human|person|staff|operator|transfer me|speak to (a )?(human|person|agent|someone)|talk to (a )?(human|person|agent)|representative|manager)\b/i.test(
      t,
    ) ||
    /موظف|بشري|تحدث مع|أريد شخص|موظف استقبال|خدمة العملاء|مندوب/.test(text)
  ) {
    return 'human'
  }

  if (
    /\b(complain|complaint|problem|issue|broken|dirty|noise|noisy|disappointed|unacceptable|refund|not working|forgot my luggage|empty minibar|angry|terrible|worst|leaking|leak|drain|shower|maintenance|repair|ac\b|a\/c|air\s*cond)\b/i.test(
      t,
    ) ||
    /شكوى|مشكلة|عطل|وسخ|ضوضاء|ممتعض|استرجاع|لا يعمل|حقيبة|ثلاجة فارغة|تسريب|مكيف|تكييف/.test(text)
  ) {
    return 'complaint'
  }

  // OTA / already paid / existing reservation: modify callback, not new booking
  if (isOtaOrExistingBooking(text)) {
    return 'modify'
  }

  // Modify/cancel before reservation: "change my booking" / "change existing book"
  if (
    /\b(modif|change.*(booking|reservation|stay|book)|alter|update.*(booking|reservation)|cancel.*(booking|reservation|stay)|cancel\b)\b/i.test(
      t,
    ) ||
    /تعديل|إلغاء|تغيير الحجز|تغيير موعد/.test(text)
  ) {
    return 'modify'
  }

  if (isGoodbyePhrase(text)) return 'goodbye'

  // Rates / price before "room" reservation keyword (never bare Arabic كم: hits عليكم)
  if (
    /\b(how much|price|prices|cost|costs|rate|rates|per night|nightly|tariff)\b/i.test(t) ||
    /سعر|أسعار|كم\s*(سعر|تكلفة|يكلف)|تكلفة/.test(text)
  ) {
    if (!/\b(book|reserv|inquiry|take (an? )?inquiry|change my)\b/i.test(t)) return 'rates'
  }

  // Off-topic chatter before FAQ (e.g. "poem about cats" must not hit pets)
  if (isOffTopicChatter(text)) return 'unknown'

  // Dining / table without stay words — before reservation so "book a table" isn't a room stay
  if (isDiningWithoutStay(text)) {
    const inclusionQ =
      /\b(included|complimentary|free|half\s*board|full\s*board|charge|extra|cost|fee)\b/i.test(t) ||
      /شامل|مجاني|برسوم|هل الفطور/.test(text)
    if (!inclusionQ) return 'dining'
  }

  if (
    /\b(dining|restaurant|dinner|lunch|breakfast|table for|book a table|eat)\b/i.test(t) ||
    /مطعم|عشاء|غداء|فطور|طاولة/.test(text)
  ) {
    // “Is breakfast complimentary / included?” is FAQ, not a table booking
    const inclusionQ =
      /\b(included|complimentary|free|half\s*board|full\s*board|charge|extra|cost|fee)\b/i.test(t) ||
      /شامل|مجاني|برسوم|هل الفطور/.test(text)
    if (!inclusionQ && !isNewReservationUtterance(text)) return 'dining'
  }

  if (/\b(spa|massage|wellness|hammam|valmont)\b/i.test(t) || /سبا|مساج|حمام/.test(text)) {
    if (!isNewReservationUtterance(text)) return 'spa'
  }

  if (isShortConfirm(text)) return 'confirm'

  if (
    (/^\s*(no|wrong|incorrect|not right|change that|wait)\s*$/i.test(t) ||
      /^(لا|غلط|خطأ|مو صح|ليس كذلك)\b/.test(text.trim())) &&
    text.trim().length < 40
  ) {
    return 'deny'
  }

  if (/arabic\s*please|english\s*please|بالعربي|بالإنجليز/i.test(text)) {
    return 'faq'
  }

  // Relative date alone (tomorrow/tonight) without stay words → not a booking
  if (isRelativeDateOnlyWithoutStay(text)) {
    return 'unknown'
  }

  // Stay dates provided (even without "book") → reservation collect, not FAQ
  if (
    !isDiningWithoutStay(text) &&
    ((/check[\s-]?in/.test(t) && /check[\s-]?out/.test(t)) ||
      (extractAllDates(text).length >= 2 && /\b(oct|nov|dec|jan|feb|mar|apr|jun|jul|aug|sep|to|until|-|–)\b/i.test(t)))
  ) {
    return 'reservation'
  }

  if (
    !isDiningWithoutStay(text) &&
    (isAvailabilityOrConfirmNow(text) ||
      isIncompleteBookingLead(text) ||
      isStartInquiryPhrase(text) ||
      /\b(reservations?|booking|book(ing)?s?|rooms?|stay|accommodation|new booking|availability|nights?|want a room|room pls|sold out)\b/i.test(
        t,
      ) ||
      /\b((i('d| would)?\s+)?(like|want|need)\s+to\s+book)\b/i.test(t) ||
      /\b(i\s+)?(need|want)\s+(a\s+)?(reservation|booking)\b/i.test(t) ||
      (/\bbook(\s+please|\s+pls)?\b/i.test(t) && hasStayWords(text)) ||
      /حجز|غرفة|إقامة|ليال/.test(text))
  ) {
    return 'reservation'
  }

  if (isQuickQuestionLead(text)) return 'faq'

  if (isRoomTypeQuestion(text)) return 'faq'

  if (matchFaq(text)) return 'faq'

  return 'unknown'
}

function pad2(n: number | string): string {
  return String(n).padStart(2, '0')
}

function isValidYmd(y: number, m: number, d: number): boolean {
  if (y < 2020 || y > 2035 || m < 1 || m > 12 || d < 1 || d > 31) return false
  const dt = new Date(y, m - 1, d)
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d
}

function toIso(y: number, m: number, d: number): string | null {
  if (!isValidYmd(y, m, d)) return null
  return `${y}-${pad2(m)}-${pad2(d)}`
}

function expandYear(y: number): number {
  if (y >= 100) return y
  // 20-35 → 2020-2035; 0-19 → 2000-2019 (still expand); prefer 20xx for demo
  return 2000 + y
}

/** Today in local timezone as Date at noon (stable for day math). */
function todayLocal(): Date {
  const n = new Date()
  return new Date(n.getFullYear(), n.getMonth(), n.getDate(), 12, 0, 0)
}

function addDays(base: Date, days: number): string {
  const d = new Date(base)
  d.setDate(d.getDate() + days)
  return toIso(d.getFullYear(), d.getMonth() + 1, d.getDate())!
}

const WEEKDAYS: Record<string, number> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  thur: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
}

function nextWeekday(name: string, from = todayLocal()): string | null {
  const target = WEEKDAYS[name.toLowerCase()]
  if (target === undefined) return null
  const cur = from.getDay()
  let add = (target - cur + 7) % 7
  if (add === 0) add = 7 // "next Monday" = upcoming, not today
  return addDays(from, add)
}

/** Arrival / late check-in time like 5pm, 17:00, 10 PM */
export function parseTime(text: string): string | null {
  const t = text.toLowerCase()
  const ampm = t.match(/\b(\d{1,2})(?: (\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/i)
  if (ampm) {
    let h = parseInt(ampm[1], 10)
    const m = ampm[2] ? parseInt(ampm[2], 10) : 0
    const ap = ampm[3].toLowerCase().replace(/\./g, '')
    if (ap.startsWith('p') && h < 12) h += 12
    if (ap.startsWith('a') && h === 12) h = 0
    if (h > 23 || m > 59) return null
    return `${pad2(h)}:${pad2(m)}`
  }
  const h24 = t.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/)
  if (h24) return `${pad2(h24[1])}:${h24[2]}`
  // Arabic-ish: الساعة 5 مساء / بعد الخامسة
  if (/مساء|ليلا|بالليل|بعد\s*العاشرة/.test(text)) {
    const n = text.match(/(\d{1,2})/)
    if (n) {
      let h = parseInt(n[1], 10)
      if (h < 12) h += 12
      return `${pad2(h)}:00`
    }
  }
  return null
}

function parseRelativeDate(text: string): string | null {
  const t = text.toLowerCase().trim()
  const base = todayLocal()

  if (/\b(today|tonight)\b/.test(t) || /\bاليوم\b/.test(text)) return addDays(base, 0)
  if (/\b(tomorrow|tmrw|tmr|tommorow|tomorow)\b/.test(t) || /\bغداً?\b|\bبكره\b|\bبكرا\b/.test(text)) {
    return addDays(base, 1)
  }
  if (/\b(day after tomorrow|overmorrow)\b/.test(t) || /\bبعد\s*غد/.test(text)) return addDays(base, 2)

  const inDays =
    t.match(/\b(?:in|after|within)\s+(\d+)\s*days?\b/) ||
    text.match(/بعد\s+(\d+)\s*أيام?/) ||
    text.match(/خلال\s+(\d+)\s*أيام?/)
  if (inDays) return addDays(base, parseInt(inDays[1], 10))

  if (/\bin\s+a\s+week\b|\bafter\s+a\s+week\b|\bnext\s+week\b/.test(t) || /بعد\s*أسبوع|الأسبوع\s*القادم/.test(text)) {
    return addDays(base, 7)
  }
  if (/\bin\s+two\s+weeks\b|\bafter\s+2\s+weeks\b/.test(t)) return addDays(base, 14)

  const nextWd = t.match(/\bnext\s+(sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs(?:day)?)?|fri(?:day)?|sat(?:urday)?)\b/)
  if (nextWd) return nextWeekday(nextWd[1], base)

  const onWd = t.match(/\b(?:this\s+)?(sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs(?:day)?)?|fri(?:day)?|sat(?:urday)?)\b/)
  if (onWd && !/\b(check|room|book)/.test(t)) {
    // only if weekday is clearly a date cue
    if (/\b(on|by|from|until|till)\b/.test(t) || text.length < 25) return nextWeekday(onWd[1], base)
  }

  return null
}

/**
 * Interpret three numbers as a calendar date.
 * Supports: YYYY-MM-DD, DD-MM-YYYY, MM-DD-YYYY (US), YY-MM-DD, MM-YY-DD, DD-YYYY-MM, etc.
 * Gulf default when ambiguous: day-month-year (DD/MM).
 */
function interpretTriple(a: number, b: number, c: number): string | null {
  // Exactly one looks like a 4-digit year
  if (a >= 2020 && a <= 2035) return toIso(a, b, c) // YYYY-MM-DD
  if (c >= 2020 && c <= 2035) {
    // DD-MM-YYYY vs MM-DD-YYYY
    if (a > 12 && b <= 12) return toIso(c, b, a) // DD-MM-YYYY
    if (b > 12 && a <= 12) return toIso(c, a, b) // MM-DD-YYYY
    // both <= 12 → Gulf day-first
    return toIso(c, b, a) // DD-MM-YYYY
  }
  if (b >= 2020 && b <= 2035) {
    // DD-YYYY-MM or MM-YYYY-DD
    if (a > 12 && c <= 12) return toIso(b, c, a) // DD-YYYY-MM
    if (c > 12 && a <= 12) return toIso(b, a, c) // MM-YYYY-DD
    return toIso(b, c, a) // prefer DD-YYYY-MM
  }

  // 2-digit year in one slot (e.g. 26 = 2026)
  const asYear = (n: number) => n >= 20 && n <= 35

  if (asYear(a) && b <= 12 && c <= 31) return toIso(expandYear(a), b, c) // YY-MM-DD
  if (asYear(b) && a <= 12 && c <= 31) return toIso(expandYear(b), a, c) // MM-YY-DD
  if (asYear(c) && b <= 12 && a <= 31) {
    if (a > 12) return toIso(expandYear(c), b, a) // DD-MM-YY
    // ambiguous MM-DD-YY vs DD-MM-YY → Gulf DD-MM-YY
    return toIso(expandYear(c), b, a)
  }

  return null
}

function parseNumericDateToken(token: string): string | null {
  const parts = token.split(/[\/\-._]/).map((p) => p.trim()).filter(Boolean)
  if (parts.length !== 3) return null
  if (!parts.every((p) => /^\d{1,4}$/.test(p))) return null
  const [a, b, c] = parts.map((p) => parseInt(p, 10))
  return interpretTriple(a, b, c)
}

/** Find all plausible dates in free text (order preserved). */
export function extractAllDates(text: string): string[] {
  const found: string[] = []
  const push = (iso: string | null) => {
    if (iso && !found.includes(iso)) found.push(iso)
  }

  const months: Record<string, number> = {
    jan: 1,
    january: 1,
    feb: 2,
    february: 2,
    mar: 3,
    march: 3,
    apr: 4,
    april: 4,
    may: 5,
    jun: 6,
    june: 6,
    jul: 7,
    july: 7,
    aug: 8,
    august: 8,
    sep: 9,
    sept: 9,
    september: 9,
    oct: 10,
    october: 10,
    nov: 11,
    november: 11,
    dec: 12,
    december: 12,
  }
  const monthAlt = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?'

  // ISO first
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    push(toIso(parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)))
  }

  // Numeric with separators
  for (const m of text.matchAll(/\b(\d{1,4}[\/\-._]\d{1,4}[\/\-._]\d{1,4})\b/g)) {
    push(parseNumericDateToken(m[1]))
  }

  // Month Day–Day range: Oct 10-13 / October 10–13
  for (const m of text.matchAll(
    new RegExp(`\\b(${monthAlt})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*[-–—to]+\\s*(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(\\d{2,4}))?`, 'gi'),
  )) {
    const month = months[m[1].toLowerCase()]
    const year = m[4] ? expandYear(parseInt(m[4], 10)) : todayLocal().getFullYear()
    push(toIso(year, month, parseInt(m[2], 10)))
    push(toIso(year, month, parseInt(m[3], 10)))
  }

  // Day of Month [Year]: 12 of October / 8 of October 2026
  for (const m of text.matchAll(
    new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+of\\s+(${monthAlt})(?:\\s+(\\d{2,4}))?\\b`, 'gi'),
  )) {
    const month = months[m[2].toLowerCase()]
    const year = m[3] ? expandYear(parseInt(m[3], 10)) : todayLocal().getFullYear()
    push(toIso(year, month, parseInt(m[1], 10)))
  }

  // Day Month [Year]: 10 October / 10 Oct 2026
  for (const m of text.matchAll(
    new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${monthAlt})(?:\\s+(\\d{2,4}))?\\b`, 'gi'),
  )) {
    const month = months[m[2].toLowerCase()]
    const year = m[3] ? expandYear(parseInt(m[3], 10)) : todayLocal().getFullYear()
    push(toIso(year, month, parseInt(m[1], 10)))
  }

  // Month Day [Year]: Oct 10 / October 10, 2026
  // (?!\d) stops "October 2026" from becoming day=20 year=26
  for (const m of text.matchAll(
    new RegExp(`\\b(${monthAlt})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?!\\d)(?:,?\\s*(\\d{2,4}))?\\b`, 'gi'),
  )) {
    const month = months[m[1].toLowerCase()]
    const year = m[3] ? expandYear(parseInt(m[3], 10)) : todayLocal().getFullYear()
    push(toIso(year, month, parseInt(m[2], 10)))
  }

  return found
}

export function parseDate(text: string): string | null {
  const t = text.trim()
  if (!t) return null

  // Relative phrases first ("tomorrow 5pm")
  const relative = parseRelativeDate(t)
  if (relative) return relative

  const numeric = extractAllDates(t)
  if (numeric[0]) return numeric[0]

  const months: Record<string, string> = {
    jan: '01',
    january: '01',
    feb: '02',
    february: '02',
    mar: '03',
    march: '03',
    apr: '04',
    april: '04',
    may: '05',
    jun: '06',
    june: '06',
    jul: '07',
    july: '07',
    aug: '08',
    august: '08',
    sep: '09',
    sept: '09',
    september: '09',
    oct: '10',
    october: '10',
    nov: '11',
    november: '11',
    dec: '12',
    december: '12',
    أكتوبر: '10',
    اكتوبر: '10',
    سبتمبر: '09',
    نوفمبر: '11',
    ديسمبر: '12',
    يناير: '01',
    فبراير: '02',
    مارس: '03',
    أبريل: '04',
    ابريل: '04',
    مايو: '05',
    يونيو: '06',
    يوليو: '07',
    أغسطس: '08',
    اغسطس: '08',
  }

  const named = t.match(
    /(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|أكتوبر|اكتوبر|سبتمبر|نوفمبر|ديسمبر|يناير|فبراير|مارس|أبريل|ابريل|مايو|يونيو|يوليو|أغسطس|اغسطس)(?:\s+(\d{2,4}))?/i,
  )
  if (named) {
    const day = parseInt(named[1], 10)
    const month = parseInt(months[named[2].toLowerCase()] || months[named[2]] || '0', 10)
    let year = named[3] ? expandYear(parseInt(named[3], 10)) : todayLocal().getFullYear()
    // if month already passed this year and no year given, could still be fine for future bookings
    return toIso(year, month, day)
  }

  const named2 = t.match(
    /(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?(?!\d)(?:,?\s+(\d{2,4}))?/i,
  )
  if (named2) {
    const month = parseInt(months[named2[1].toLowerCase()], 10)
    const day = parseInt(named2[2], 10)
    const year = named2[3] ? expandYear(parseInt(named2[3], 10)) : todayLocal().getFullYear()
    return toIso(year, month, day)
  }

  // Arabic: من 10 إلى 13 أكتوبر
  const arRange = t.match(/من\s+(\d{1,2})\s+إلى\s+(\d{1,2})\s+(أكتوبر|اكتوبر|سبتمبر|نوفمبر|ديسمبر|يناير)/)
  if (arRange) {
    const month = parseInt(months[arRange[3]] || '10', 10)
    const year = todayLocal().getFullYear()
    return toIso(year, month, parseInt(arRange[1], 10))
  }

  return null
}

/** Parse check-in + optional check-out + optional arrival time from one utterance. */
export function parseStayDates(text: string): {
  checkIn: string | null
  checkOut: string | null
  arrivalTime: string | null
} {
  const arrivalTime = parseTime(text)
  const all = extractAllDates(text)

  // "check-in X check-out Y"
  const cio = text.match(/check[\s-]?in\s+(.+?)\s+check[\s-]?out\s+(.+?)(?:\.|,|$)/i)
  if (cio) {
    const a = parseDate(cio[1].trim()) || extractAllDates(cio[1])[0]
    const b = parseDate(cio[2].trim()) || extractAllDates(cio[2])[0]
    if (a && b) return { checkIn: a, checkOut: b, arrivalTime }
  }

  // "from X to Y" / "X until Y" / "X - Y" / "next Friday to Sunday"
  const rangeWords = text.match(
    /(?:from|check[\s-]?in)?\s*(.+?)\s+(?:to|until|till|through|-|–|—)\s+(.+?)(?:\.|,|$|for\s+\d)/i,
  )
  if (rangeWords) {
    const left = rangeWords[1].trim()
    const right = rangeWords[2].trim()
    // weekday range: next Friday to Sunday
    const leftWd = left.match(/\b(?:next\s+)?(sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs(?:day)?)?|fri(?:day)?|sat(?:urday)?)\b/i)
    const rightWd = right.match(/\b(sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs(?:day)?)?|fri(?:day)?|sat(?:urday)?)\b/i)
    if (leftWd && rightWd) {
      const from = /\bnext\b/i.test(left) ? nextWeekday(leftWd[1]) : nextWeekday(leftWd[1])
      if (from) {
        const [y, m, d] = from.split('-').map((x) => parseInt(x, 10))
        const base = new Date(y, m - 1, d, 12)
        const out = nextWeekday(rightWd[1], base)
        if (out) return { checkIn: from, checkOut: out, arrivalTime }
      }
    }
    const a = parseDate(left) || extractAllDates(left)[0]
    const b = parseDate(right) || extractAllDates(right)[0]
    if (a && b) return { checkIn: a, checkOut: b, arrivalTime }
  }

  const arRange = text.match(/من\s+(\d{1,2})\s+إلى\s+(\d{1,2})\s+(أكتوبر|اكتوبر|سبتمبر|نوفمبر|ديسمبر)/)
  if (arRange) {
    const months: Record<string, string> = {
      أكتوبر: '10',
      اكتوبر: '10',
      سبتمبر: '09',
      نوفمبر: '11',
      ديسمبر: '12',
    }
    const month = parseInt(months[arRange[3]] || '10', 10)
    const year = todayLocal().getFullYear()
    return {
      checkIn: toIso(year, month, parseInt(arRange[1], 10)),
      checkOut: toIso(year, month, parseInt(arRange[2], 10)),
      arrivalTime,
    }
  }

  // "tomorrow for 3 nights" / "for 2 nights" / "for two days from today" / "from 8 Oct for 2 days"
  const wordNum: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
  }
  const duration =
    text.match(/\b(?:for\s+)?(\d+)\s*(?:nights?|days?)\b/i) ||
    text.match(/\b(?:for\s+)?(one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:nights?|days?)\b/i) ||
    text.match(/(\d+)\s*ليال/) ||
    text.match(/(\d+)\s*أيام/)
  const durationN = duration
    ? /^\d+$/.test(duration[1])
      ? parseInt(duration[1], 10)
      : wordNum[duration[1].toLowerCase()] ?? null
    : null

  // "from today for 2 days" / "for 2 days from today" / "starting today for 2 nights"
  const fromToday =
    /\b(?:from\s+|starting\s+)?today\b/i.test(text) ||
    /\b(?:for\s+)?(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:days?|nights?)\s+(?:from\s+|starting\s+)?today\b/i.test(
      text,
    ) ||
    /\btoday\s+(?:for\s+)?(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:days?|nights?)\b/i.test(text)
  if (fromToday && durationN != null && durationN > 0) {
    const checkIn = addDays(todayLocal(), 0)
    const [y, m, d] = checkIn.split('-').map((x) => parseInt(x, 10))
    return {
      checkIn,
      checkOut: addDays(new Date(y, m - 1, d, 12), durationN),
      arrivalTime,
    }
  }

  // "from 8 Oct for 2 days" / "8 October for 2 nights" / "10 Oct for two days"
  const monthToken =
    'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?'
  const fromFor = text.match(
    new RegExp(
      String.raw`\b(?:from\s+|on\s+|starting\s+)?(\d{1,2}(?:st|nd|rd|th)?\s+(?:${monthToken})(?:\s+\d{2,4})?|\d{1,2}[\/\-.]\d{1,2}(?:[\/\-.]\d{2,4})?)\s+(?:or\s+(?:\d{1,2}(?:st|nd|rd|th)?\s+(?:${monthToken})(?:\s+\d{2,4})?)\s+)?for\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:days?|nights?)\b`,
      'i',
    ),
  )
  if (fromFor) {
    const checkIn = parseDate(fromFor[1]) || extractAllDates(fromFor[1])[0]
    const n = /^\d+$/.test(fromFor[2]) ? parseInt(fromFor[2], 10) : wordNum[fromFor[2].toLowerCase()]
    if (checkIn && n && n > 0) {
      const [y, m, d] = checkIn.split('-').map((x) => parseInt(x, 10))
      return { checkIn, checkOut: addDays(new Date(y, m - 1, d, 12), n), arrivalTime }
    }
  }

  const nights =
    text.match(/\b(?:for\s+)?(\d+)\s*nights?\b/i) ||
    text.match(/\b(?:for\s+)?(one|two|three|four|five|six|seven|eight|nine|ten)\s*nights?\b/i) ||
    text.match(/(\d+)\s*ليال/)
  const daysOnly =
    text.match(/\b(?:for\s+)?(\d+)\s*days?\b/i) ||
    text.match(/\b(?:for\s+)?(one|two|three|four|five|six|seven|eight|nine|ten)\s*days?\b/i)
  const checkIn = all[0] || parseRelativeDate(text) || parseDate(text)
  let checkOut = all[1] || null
  const spanRaw = nights?.[1] ?? daysOnly?.[1]
  const span = spanRaw
    ? /^\d+$/.test(spanRaw)
      ? parseInt(spanRaw, 10)
      : wordNum[spanRaw.toLowerCase()]
    : durationN
  // If guest gave two dates without "to" (e.g. alternatives), prefer first + duration when duration present
  if (checkIn && span && (!checkOut || durationN != null)) {
    const [y, m, d] = checkIn.split('-').map((x) => parseInt(x, 10))
    const base = new Date(y, m - 1, d, 12)
    checkOut = addDays(base, span)
  }

  return { checkIn, checkOut, arrivalTime }
}

export function parsePhone(text: string): string | null {
  const withoutDates = text.replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')
  const m =
    withoutDates.match(/(\+971[\d\s\-()]{7,}\d)/i) ||
    withoutDates.match(/(\+\d[\d\s\-()]{7,}\d)/) ||
    withoutDates.match(/\b(05\d[\d\s\-()]{6,}\d)\b/) ||
    withoutDates.match(/(\+?\d[\d\s\-()]{8,}\d)/)
  if (!m) return null
  const phone = m[1].replace(/\s+/g, ' ').trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(phone)) return null
  return phone
}

function titleCaseName(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ')
}

const NAME_STOPWORDS = new Set([
  'room',
  'rooms',
  'pls',
  'please',
  'adult',
  'adults',
  'child',
  'children',
  'kid',
  'kids',
  'people',
  'person',
  'persons',
  'guest',
  'guests',
  'pax',
  'night',
  'nights',
  'check',
  'in',
  'out',
  'to',
  'from',
  'until',
  'till',
  'and',
  'for',
  'with',
  'phone',
  'mobile',
  'booking',
  'reservation',
  'late',
  'early',
  'want',
  'need',
  'book',
  'confirm',
  'abu',
  'dhabi',
  'dubai',
  'marina',
  'airport',
  'spa',
  'erth',
  'oct',
  'october',
  'nov',
  'november',
  'dec',
  'december',
  'jan',
  'january',
  'feb',
  'february',
  'mar',
  'march',
  'apr',
  'april',
  'may',
  'jun',
  'june',
  'jul',
  'july',
  'aug',
  'august',
  'sep',
  'sept',
  'september',
  'sun',
  'sunday',
  'mon',
  'monday',
  'tue',
  'tues',
  'tuesday',
  'wed',
  'wednesday',
  'thu',
  'thur',
  'thurs',
  'thursday',
  'fri',
  'friday',
  'sat',
  'saturday',
  'family',
  'of',
  'the',
  'a',
  'an',
])

function looksLikePersonName(segment: string): boolean {
  const words = segment
    .trim()
    .replace(/[.?!,]/g, '')
    .split(/\s+/)
    .filter(Boolean)
  if (words.length < 2 || words.length > 4) return false
  if (words.some((w) => /\d/.test(w))) return false
  if (words.some((w) => NAME_STOPWORDS.has(w.toLowerCase()))) return false
  if (!words.every((w) => /^[A-Za-z\u0600-\u06FF][A-Za-z\u0600-\u06FF'.-]*$/.test(w))) return false
  return true
}

/** Pull a bare person name from a WhatsApp-style multi-field dump (no "name" label). */
export function extractUnlabeledName(text: string): string | null {
  let residual = text
  // Phones
  residual = residual
    .replace(/\+971[\d\s\-()]{7,}\d/gi, ' ')
    .replace(/\+\d[\d\s\-()]{7,}\d/g, ' ')
    .replace(/\b05\d[\d\s\-()]{6,}\d\b/g, ' ')
  // ISO / numeric dates
  residual = residual
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')
    .replace(/\b\d{1,2}[\/\-._]\d{1,2}[\/\-._]\d{2,4}\b/g, ' ')
  // Named month ranges and singles: 15 oct to 18 oct / 20 oct - 22 oct / Oct 10
  residual = residual
    .replace(
      /\b\d{1,2}(?:st|nd|rd|th)?\s*(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s*(?:to|until|till|-|–|—)\s*\d{1,2}(?:st|nd|rd|th)?(?:\s*(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?))?/gi,
      ' ',
    )
    .replace(
      /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?\s*(?:to|until|till|-|–|—)\s*\d{1,2}(?:st|nd|rd|th)?/gi,
      ' ',
    )
    .replace(
      /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/gi,
      ' ',
    )
    .replace(
      /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?\b/gi,
      ' ',
    )
  // Guest / room / night counts and labels
  residual = residual
    .replace(/\b\d+\s*(?:adults?|children|child|kids?|people|persons?|guests?|pax|rooms?|nights?)\b/gi, ' ')
    .replace(/\bfamily\s+of\s+\d+\b/gi, ' ')
    .replace(/\b(?:check[\s-]?in|check[\s-]?out|phone|mobile|tel|name(?:\s+is)?|guest\s+name|my\s+name\s+is)\b[:\s]*/gi, ' ')
    .replace(/\b(?:room\s+pls|a\s+room|want\s+a\s+room|book\s+a\s+room|need\s+a\s+room|late\s+check[\s-]?in|arriving\s+late)\b/gi, ' ')
    .replace(/\b(?:to|until|till|from|and)\b/gi, ' ')

  const segments = residual
    .split(/[,;|\n/]+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean)

  for (const seg of segments) {
    if (looksLikePersonName(seg)) return titleCaseName(seg)
  }

  // Capitalized run still left in residual
  const cap = residual.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\b/)
  if (cap && looksLikePersonName(cap[1])) return titleCaseName(cap[1])

  return null
}

export function parseName(text: string): string | null {
  // "hmm", "uh-huh", "haan", "sorry?" are backchannels, never a guest name
  if (isFillerUtterance(text)) return null
  if (/ahmed\s+al\s*mansoori|أحمد\s*المنصوري|احمد\s*المنصوري/i.test(text)) {
    return 'Ahmed Al Mansoori'
  }

  // Explicit "Name X" / "My name is X" / "guest Maya"
  const explicit = text.match(
    /(?:(?:my\s+)?name(?:\s+is)?|i(?:'m| am)|guest(?:\s+name)?|اسمي|الاسم)\s*[:\s]+([A-Za-z\u0600-\u06FF][A-Za-z\u0600-\u06FF\s.'-]{1,40}?)(?=\s*(?:,|\.|$|phone|هاتف|\+|confirmation|conf(?:irmation)?|check[\s-]?in|رقم|أريد|move|for|and\s+\+|adult|\d))/i,
  )
  if (explicit) {
    const n = explicit[1].replace(/[.?!,]/g, '').trim()
    if (n.length >= 2 && n.split(/\s+/).length <= 5) return titleCaseName(n)
  }

  // Multi-field dump (dates/guests/phone present): extract unlabeled bare name
  if (
    /[+,]/.test(text) ||
    /\b(adults?|kids?|children|oct|nov|dec|jan|feb|mar|apr|jun|jul|aug|sep|\+971|phone|check[\s-]?in)\b/i.test(text)
  ) {
    const unlabeled = extractUnlabeledName(text)
    if (unlabeled) return unlabeled
  }

  // Demo shortcuts
  if (/\bsara\s+khan\b/i.test(text)) return 'Sara Khan'

  // Name-only short utterances (collect_name step)
  const cleaned = text
    .replace(/^(my name is|i am|i'm|this is|name is|it's|guest name|اسمي|الاسم)\s+/i, '')
    .replace(/[.?!,]/g, '')
    .trim()
  if (cleaned.length < 2 || cleaned.length > 40) return null
  if (isFillerUtterance(cleaned)) return null
  if (/^\+?\d/.test(cleaned)) return null
  if (/\b(need|change|booking|phone|confirmation|check|want|please|room|adult|oct|nov)\b/i.test(cleaned)) return null
  const words = cleaned.split(/\s+/)
  if (words.length > 4) return null
  if (words.some((w) => NAME_STOPWORDS.has(w.toLowerCase()))) return null
  return titleCaseName(cleaned)
}

export function parseGuests(text: string): { adults: number | null; children: number | null } {
  const t = text.toLowerCase()

  // Rooms-only answers must not become guest counts
  if (isRoomsOnlyPhrase(text) && !/\b(adult|people|person|guest|child|kid|pax|family|grand|infant|toddler|baby|couple)\b/i.test(t)) {
    return { adults: null, children: null }
  }

  // Couples / families / mixed parties (2 couples, couple + family with kids, …)
  const party = parsePartyComposition(text)
  if (party.adults != null) {
    let adults = party.adults
    let children = party.children
    const gparentsNum = t.match(/(\d+)\s*grandparents?/)
    const gparentWord = t.match(/\b(one|two)\s+grandparents?\b/)
    if (gparentsNum) adults += parseInt(gparentsNum[1], 10)
    else if (gparentWord) adults += PARTY_WORD_NUM[gparentWord[1]] ?? 1
    else if (/\bgrandparents\b/.test(t)) adults += 2
    else if (/\bgrandparent\b/.test(t)) adults += 1
    else if (/\b(?:with\s+)?(?:my\s+)?parents\b/.test(t) && !/\bcouple/.test(t)) adults += 2
    // Explicit "N adults" / "N children" can refine when guest states totals
    const a = t.match(/(\d+)\s*adults?/)
    const c = t.match(/(\d+)\s*child(?:ren)?/) || t.match(/(\d+)\s*kids?\b/)
    if (a && parseInt(a[1], 10) > adults) adults = parseInt(a[1], 10)
    if (c) children = parseInt(c[1], 10)
    if (children === null && /\bno child|without child|0 child|no kids|بدون أطفال|لا أطفال/i.test(text)) {
      children = 0
    }
    return { adults, children }
  }

  let adults: number | null = null
  let children: number | null = null

  const family = t.match(/\bfamily\s+of\s+(\d+)\b/) || text.match(/عائلة\s*من\s*(\d+)/)
  if (family) {
    const n = parseInt(family[1], 10)
    if (n >= 2) {
      adults = 2
      children = Math.max(0, n - 2)
    } else {
      adults = n
      children = 0
    }
  }

  // Couple alone: do not wipe children if kids already / also mentioned
  if (
    /\b(couple|for\s+two|two\s+people|2\s+people|2\s+persons?|just\s+(us|two)|me\s+and\s+my\s+(wife|husband|partner))\b/.test(
      t,
    ) &&
    !/\b(child|kid|infant|toddler|baby|grand|parent|famil)\b/.test(t)
  ) {
    adults = 2
    children = 0
  } else if (
    /\b(couple|me\s+and\s+my\s+(wife|husband|partner))\b/.test(t) &&
    adults === null
  ) {
    adults = 2
  }

  if (/\b(solo|just\s+me|only\s+me|one\s+person|1\s+person|single\s+traveler)\b/.test(t) && adults === null) {
    adults = 1
    children = children ?? 0
  }

  const a =
    t.match(/(\d+)\s*adults?/) ||
    t.match(/\b(one|two|three|four|five|six)\s+adults?\b/) ||
    text.match(/(\d+)\s*بالغ/)
  const c =
    t.match(/(\d+)\s*child(?:ren)?/) ||
    t.match(/(\d+)\s*kids?\b/) ||
    t.match(/\b(one|two|three|four|five|six)\s+(?:children|kids|child|kid)\b/) ||
    t.match(/(\d+)\s*(?:infants?|toddlers?|babies|baby)\b/) ||
    text.match(/(\d+)\s*طفل/)
  const wordAdults: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 }
  const gparentsNum = t.match(/(\d+)\s*grandparents?/)
  const gparentWord = t.match(/\b(one|two)\s+grandparents?\b/)
  const people = t.match(/(\d+)\s*(?:people|persons?|guests?|pax)\b/)
  if (a) {
    adults = /^\d+$/.test(a[1]) ? parseInt(a[1], 10) : wordAdults[a[1]] ?? adults
  }
  if (c) {
    children = /^\d+$/.test(c[1]) ? parseInt(c[1], 10) : wordAdults[c[1]] ?? children
  }
  if (gparentsNum) {
    adults = (adults ?? 0) + parseInt(gparentsNum[1], 10)
  } else if (gparentWord) {
    adults = (adults ?? 0) + (wordAdults[gparentWord[1]] ?? 1)
  } else if (/\bgrandparents\b/.test(t)) {
    adults = (adults ?? 0) + 2
  } else if (/\bgrandparent\b/.test(t)) {
    adults = (adults ?? 0) + 1
  } else if (/\b(?:with\s+)?(?:my\s+)?parents\b/.test(t)) {
    adults = (adults ?? 0) + 2
  }

  if (people && adults === null) {
    adults = parseInt(people[1], 10)
    if (children === null) children = 0
  }

  if (/شخصين|ثنين بالغ|بالغين/.test(text) && adults === null) adults = 2
  if (/وطفل|وطفلة|طفل واحد/.test(text) && children === null) children = 1

  if (children === null && /\b(?:and\s+)?(?:a|one)\s+(?:child|kid|toddler|baby)\b/.test(t)) {
    children = 1
  }
  if (children === null && /\b(?:and\s+)?(?:two|2)\s+(?:children|kids|toddlers)\b/.test(t)) {
    children = 2
  }

  if (adults === null && children === null && !/\broom\b/i.test(t)) {
    const nums = t.match(/\d+/g)
    if (nums && nums.length >= 2 && /\b(adult|child|kid|and|grand)\b/.test(t)) {
      adults = parseInt(nums[0], 10)
      children = parseInt(nums[1], 10)
    } else if (nums && nums.length === 1 && /\b(adult|people|person|guest|pax)\b/.test(t)) {
      adults = parseInt(nums[0], 10)
      children = 0
    }
  }
  if (children === null && /\bno child|without child|0 child|no kids|بدون أطفال|لا أطفال/i.test(text)) {
    children = 0
  }
  return { adults, children }
}

/** Multi-room layout notes: couple rooms, couple + family, connecting, etc. */
export function parseRoomLayout(text: string): { rooms: number | null; note: string | null } {
  const t = text.toLowerCase()
  const notes: string[] = []
  let rooms = parseRooms(text)

  const party = parsePartyComposition(text)
  if (party.rooms != null) {
    rooms = rooms ?? party.rooms
  }
  if (party.note) notes.push(party.note)

  if (
    /\b(?:one|1)\s+room\s+for\s+(?:the\s+)?(?:couple|us|adults?|parents?).{0,60}(?:one|1|\banother)\s+room\s+for\s+(?:the\s+)?(?:kids?|children|child)\b/.test(
      t,
    ) ||
    /\b(?:separate|two|2)\s+rooms?.{0,40}(?:couple|adults?|parents?).{0,40}(?:kids?|children)\b/.test(t) ||
    /\broom\s+for\s+(?:the\s+)?couple.+(?:room\s+for\s+(?:the\s+)?(?:kids?|children))\b/.test(t) ||
    /\bone\s+for\s+(?:the\s+)?couple\s+and\s+one\s+for\s+(?:the\s+)?(?:kids?|children)\b/.test(t) ||
    /\btwo\s+separate\s+rooms?\b.{0,40}(?:couple|kids|children)\b/.test(t) ||
    /\b(?:need|want)\s+(?:2|two)\s+separate\s+rooms?\b/.test(t)
  ) {
    rooms = Math.max(rooms ?? 0, 2)
    if (!notes.some((n) => /separate|kids room|1 for couple.*children/i.test(n))) {
      notes.push('Separate rooms: 1 for couple/adults + 1 for children')
    }
  }

  if (
    /\b(?:one|1)\s+(?:for\s+)?(?:the\s+)?(?:couple|adults|parents).{0,40}(?:one|1).{0,20}(?:kids?|children).{0,40}(?:one|1).{0,20}(?:grandparent|grandparents|parents)\b/.test(
      t,
    ) ||
    /\b(?:3|three)\s+(?:separate\s+)?rooms?\b/.test(t)
  ) {
    if (/\b(?:3|three)\s+(?:separate\s+)?rooms?\b/.test(t) || !notes.some((n) => /3 room|family room|couple room/i.test(n))) {
      rooms = Math.max(rooms ?? 0, 3) || 3
      if (!notes.some((n) => /3 rooms|three rooms|multi-room/i.test(n))) {
        notes.push('Multi-room layout (e.g. adults + children + grandparents): confirm assignment with guest')
      }
    }
  }

  if (/\b(?:4|four)\s+(?:separate\s+)?rooms?\b/.test(t)) {
    rooms = Math.max(rooms ?? 0, 4) || 4
    if (!notes.some((n) => /four|4 room/i.test(n))) {
      notes.push('Four-room request: confirm who shares each room')
    }
  }

  if (/\b(?:connecting|interconnecting|adjoining)\s+rooms?\b/.test(t)) {
    rooms = rooms ?? 2
    notes.push('Prefer connecting / adjoining rooms')
  }

  if (/\b(\d+)\s+rooms?\b/.test(t) && rooms == null) {
    const m = t.match(/\b(\d+)\s+rooms?\b/)
    if (m) rooms = parseInt(m[1], 10)
  }

  if (/\bfamily\s+suite\b|\bone\s+family\s+room\b/.test(t)) {
    rooms = rooms ?? 1
    notes.push('Prefer family suite / one room for the whole family if available')
  }

  return { rooms, note: notes.length ? [...new Set(notes)].join('; ') : null }
}

export function parseRooms(text: string): number | null {
  // Never treat guest counts as room counts
  if (isGuestCountPhrase(text) && !/\broom\b/i.test(text)) return null

  // "a / an / one / single room" → 1 (before bare-number fallback grabs guest counts)
  if (/\b(a|an|one|single)\s+room\b/i.test(text) || /غرفة واحدة|just one(?:\s+room)?/i.test(text)) {
    return 1
  }

  const m = text.match(/(\d+)\s*rooms?\b/i) || text.match(/(\d+)\s*غرف/)
  if (m) return parseInt(m[1], 10)
  if (/^\s*(one|1)\s*$/i.test(text.trim())) return 1
  if (/^\s*(two|2)\s*$/i.test(text.trim())) return 2
  // Bare number only when clearly about rooms, not guest counts / dates / phones
  if (
    /\broom\b/i.test(text) &&
    !isGuestCountPhrase(text) &&
    !/\d{4}-\d{2}-\d{2}/.test(text) &&
    !/\+\d/.test(text)
  ) {
    const n = text.match(/\b(\d+)\b/)
    if (n) return parseInt(n[1], 10)
  }
  return null
}

export function buildBookingSummary(b: BookingFields): string {
  const rooms = b.rooms ?? 1
  const adults = b.adults ?? 0
  const children = b.children ?? 0
  const cat = b.roomCategory ? `, prefer ${b.roomCategory}` : ''
  const special = b.specialRequests || 'none'
  return `${b.guestName || 'Guest'}, ${adults} adult${adults === 1 ? '' : 's'}${children ? ` ${children} child${children === 1 ? '' : 'ren'}` : ''}, ${rooms} room${rooms === 1 ? '' : 's'}${cat}, ${fmtDate(b.checkIn)} to ${fmtDate(b.checkOut)}, phone ${b.phone || '-'}, notes: ${special}`
}

export function buildDeskNotificationBody(
  b: BookingFields,
  afterHours: boolean,
): { subject: string; body: string } {
  const adults = b.adults ?? 0
  const children = b.children ?? 0
  const late = /late|متأخر/i.test(b.specialRequests)
  const body = late
    ? `New after-hours reservation inquiry, ${b.guestName}, ${adults} adults ${children} child${children === 1 ? '' : 'ren'}, ${fmtShortRange(b.checkIn, b.checkOut)}, late check-in, call back to confirm availability/rate.`
    : `New ${afterHours ? 'after-hours ' : ''}reservation inquiry, ${buildBookingSummary(b)}, call back to confirm availability/rate.`

  return {
    subject: `Reservation inquiry, ${b.guestName || 'Guest'}`,
    body,
  }
}

function fmtShortRange(checkIn: string, checkOut: string): string {
  try {
    const a = new Date(checkIn + 'T12:00:00')
    const b = new Date(checkOut + 'T12:00:00')
    return `${a.getDate()}–${b.getDate()} ${a.toLocaleDateString('en-GB', { month: 'short' })}`
  } catch {
    return `${checkIn}–${checkOut}`
  }
}

function faqReply(text: string, lang: Language): string {
  const key = matchFaq(text)
  if (key) {
    const answer = KNOWLEDGE[key][lang]
    const follow =
      lang === 'ar'
        ? ' هل يمكنني مساعدتكم بشيء آخر, حجز، مطعم، أو التحويل لزميل؟'
        : ' May I help with anything else, a reservation, dining, or connecting you to a colleague?'
    return answer + follow
  }
  return lang === 'ar'
    ? `يمكنني المساعدة في الحجوزات، المطاعم، السبا، المواقف، المطار، الواي فاي، أو التحويل لموظف. الاستقبال ${RESORT.frontDeskOpens}–${RESORT.frontDeskCloses}.`
    : `I can help with reservations, dining, spa, parking, airport transfers, Wi‑Fi, or connect you to a colleague. Front desk: ${RESORT.frontDeskOpens}–${RESORT.frontDeskCloses}.`
}

function stepPrompt(step: ConversationStep, lang: Language): string {
  const prompts: Partial<Record<ConversationStep, { en: string; ar: string }>> = {
    collect_check_in: {
      en: 'What is your check-in date?',
      ar: 'ما تاريخ الوصول من فضلك؟',
    },
    collect_check_out: {
      en: 'And your check-out date?',
      ar: 'وما تاريخ المغادرة؟',
    },
    collect_rooms: {
      en: 'How many rooms: e.g. 1 for a couple, 2 couple rooms, or 1 couple room + 1 family room?',
      ar: 'كم عدد الغرف؟ مثلاً غرفة للزوجين، أو غرفتان لزوجين، أو غرفة للزوجين وغرفة للعائلة؟',
    },
    collect_room_type: {
      en: 'Which room type would you like? Reply with a number from the list, or the name.',
      ar: 'أي نوع غرفة تفضلون؟ أرسلوا الرقم من القائمة أو الاسم.',
    },
    collect_guests: {
      en: 'Who is staying: e.g. 1 couple, 2 couples, or 1 couple plus a family with children?',
      ar: 'من سيقيم؟ مثلاً زوجان، أو زوجان اثنان، أو زوجان مع عائلة وأطفال؟',
    },
    collect_name: {
      en: 'May I have the guest name?',
      ar: 'ما اسم الضيف للحجز؟',
    },
    collect_phone: {
      en: 'And a mobile number we can reach you on?',
      ar: 'وما رقم الهاتف للتواصل؟',
    },
    collect_special: {
      en: 'Any special requests, or shall I note “none”?',
      ar: 'هل هناك طلبات خاصة، أم نسجّل «لا يوجد»؟',
    },
    confirm_summary: {
      en: 'Shall I confirm these details with reservations?',
      ar: 'هل تؤكدون هذه التفاصيل لإشعار الحجوزات؟',
    },
    dining_details: {
      en: 'Please share date, time, and party size.',
      ar: 'من فضلكم التاريخ والوقت وعدد الأشخاص.',
    },
    await_intent: {
      en: 'How else may I help, reservation, dining, spa, or a colleague?',
      ar: 'كيف أساعدكم أيضاً, حجز، مطعم، سبا، أو زميل؟',
    },
  }
  const p = prompts[step]
  if (!p) return ''
  return (lang === 'ar' ? ' ' + p.ar : ' ' + p.en)
}

export function greet(language: Language, afterHours: boolean): AgentReply {
  const biz = getActiveBusiness()
  if (isDentalIndustry(biz)) {
    return dentalGreet(biz, afterHours) as AgentReply
  }
  const text =
    language === 'ar'
      ? afterHours
        ? biz.greetings.arAfterHours ||
          biz.greetings.ar ||
          `أهلاً بكم في حجوزات ${biz.greetingName}. أنا مساعد ذكي للرد خارج أوقات الذروة. كيف يمكنني مساعدتكم؟`
        : biz.greetings.ar ||
          `أهلاً بكم في حجوزات ${biz.greetingName}. أنا مساعد ذكي. كيف يمكنني مساعدتكم؟`
      : afterHours
        ? biz.greetings.enAfterHours ||
          `Welcome to ${biz.greetingName} reservations. I’m an AI assistant covering after-hours and overflow. How may I help: a reservation, a change, dining, spa, or a colleague?`
        : biz.greetings.en ||
          `Welcome to ${biz.greetingName} reservations. I’m an AI assistant. How may I help: a reservation, a change, dining, spa, or a colleague?`
  return {
    text,
    toolCalls: [{ tool: 'greet', args: { language, afterHours }, result: 'Greeting delivered with AI disclosure' }],
    nextStep: 'await_intent',
    bookingUpdates: { language },
  }
}

export function processGuestMessage(opts: {
  text: string
  step: ConversationStep
  booking: BookingFields
  language: Language
  afterHours: boolean
  humanTakeover: boolean
  /** When true, mention sandbox OHIP availability stub — never invent AED rates */
  operaReadEnabled?: boolean
}): AgentReply {
  const biz = getActiveBusiness()
  if (isDentalIndustry(biz)) {
    return processDentalMessage({ biz, ...opts }) as AgentReply
  }

  const { text, step, booking, afterHours, humanTakeover, operaReadEnabled } = opts
  const language = detectLanguage(text, booking.language || opts.language)
  const langSwitch = language !== (booking.language || opts.language)
  const intent = detectIntent(text)

  const withOpera = (reply: AgentReply): AgentReply => {
    if (!operaReadEnabled) return reply
    // Soft appendix only on confirmation / rates — never invent a sell price
    if (reply.nextStep !== 'confirm_summary' && reply.intent !== 'rates' && reply.outcome !== 'booked_inquiry' && reply.outcome !== 'after_hours_saved') {
      return reply
    }
    if (/sandbox|OHIP|tentative availability/i.test(reply.text)) return reply
    const appendix =
      language === 'ar'
        ? ' قراءة Opera التجريبية تظهر توفراً مبدئياً للتواريخ (بدون سعر). الحجوزات تؤكد السعر النهائي.'
        : ' Sandbox Opera read shows tentative availability for those dates (no sell rate). Reservations confirms the final rate.'
    return { ...reply, text: reply.text + appendix }
  }

  const withLang = (reply: AgentReply): AgentReply =>
    withOpera({
      ...reply,
      bookingUpdates: { ...reply.bookingUpdates, language },
    })

  if (humanTakeover) {
    return withLang({
      text:
        language === 'ar'
          ? 'تم تفعيل التحويل البشري. سيتواصل معكم أحد الزملاء قريباً.'
          : 'Human takeover is enabled. A colleague will join this conversation shortly.',
      toolCalls: [{ tool: 'escalate_to_human', args: { reason: 'human_takeover_toggle' }, result: 'Ticket created' }],
      nextStep: 'escalated',
      bookingUpdates: {},
      intent: 'human',
      outcome: 'transferred',
      escalate: true,
      end: true,
    })
  }

  // Explicit language switch only
  if (/^(arabic please|english please|بالعربي|بالعربية|english)$/i.test(text.trim()) || langSwitch && /please|من فضلك|بالعربي|english|arabic/i.test(text) && text.length < 40) {
    if (intent === 'faq' || text.length < 40) {
      const switched =
        language === 'ar'
          ? 'تم. سأتحدث بالعربية. كيف يمكنني مساعدتكم, حجز، مطعم، سبا، أو التحدث مع زميل؟'
          : 'Certainly. I’ll continue in English. How may I help, a reservation, dining, spa, or a colleague?'
      return {
        text: switched,
        toolCalls: [{ tool: 'detect_intent', args: { language }, result: `Language set to ${language}` }],
        nextStep: COLLECT_STEPS.includes(step) ? step : 'await_intent',
        bookingUpdates: { language },
        intent: 'faq',
      }
    }
  }

  if (intent === 'human') {
    return withLang(escalateReply(language, booking))
  }

  // Hang up / end call: works after inquiry, upsell “none”, or anytime outside field collect
  if (intent === 'goodbye' && !COLLECT_STEPS.includes(step)) {
    return withLang(goodbyeReply(language, { ...booking, language }))
  }

  // Arabic greeting: never rates
  if (isArabicGreeting(text)) {
    const bizName = getActiveBusiness().greetingName
    return withLang({
      text:
        language === 'ar' || /[\u0600-\u06FF]/.test(text)
          ? `وعليكم السلام ومرحباً بكم في حجوزات إرث أبوظبي. كيف يمكنني مساعدتكم: حجز، تعديل، مطعم، سبا، أو التحدث مع زميل؟`
          : `Wa alaykum as-salam: welcome to ${bizName} reservations. How may I help: a reservation, a change, dining, spa, or a colleague?`,
      toolCalls: [{ tool: 'detect_intent', args: { intent: 'greeting' }, result: 'Arabic greeting' }],
      nextStep: COLLECT_STEPS.includes(step) ? step : 'await_intent',
      bookingUpdates: { language: /[\u0600-\u06FF]/.test(text) ? 'ar' : language },
      intent: 'faq',
    })
  }

  // Off-topic chatter (poem / football / news) — never pets FAQ
  if (isOffTopicChatter(text) && !COLLECT_STEPS.includes(step)) {
    return withLang({
      text: OFF_TOPIC_REPLY,
      toolCalls: [{ tool: 'detect_intent', args: { intent: 'unknown', offTopic: true }, result: 'off-topic redirect' }],
      nextStep: 'await_intent',
      bookingUpdates: {},
      intent: 'unknown',
    })
  }

  // Simple EN greeting only
  if (isSimpleGreetingOnly(text) && !COLLECT_STEPS.includes(step)) {
    return withLang({
      text:
        'Hello, and welcome to Erth Abu Dhabi. How may I help you today: a room reservation, a change to a booking, dining, the spa, or a colleague?',
      toolCalls: [{ tool: 'detect_intent', args: { intent: 'greeting' }, result: 'simple greeting' }],
      nextStep: 'await_intent',
      bookingUpdates: {},
      intent: 'faq',
    })
  }

  if (intent === 'complaint' && step !== 'complaint_details') {
    return withLang(handleIntent('complaint', text, language, afterHours, { ...booking, language }))
  }

  // Upsell add-ons (after inquiry or anytime)
  if (
    !COLLECT_STEPS.includes(step) ||
    step === 'confirm_summary' ||
    step === 'completed' ||
    step === 'await_intent'
  ) {
    if (isUpsellMenuAsk(text) && parseUpsellSelection(text) === null) {
      return withLang({
        text: formatUpsellMenu(language),
        toolCalls: [{ tool: 'offer_upsell', args: {}, result: 'upsell menu shown' }],
        nextStep: 'await_intent',
        bookingUpdates: {},
        intent: 'faq',
      })
    }
    const upsellNote = parseUpsellSelection(text)
    if (upsellNote) {
      const specialRequests = [booking.specialRequests, upsellNote].filter(Boolean).join('; ')
      return withLang({
        text:
          language === 'ar'
            ? `تم: سجّلت: ${upsellNote}. الحجوزات تؤكد عند الاتصال. هل تحتاجون شيئاً آخر؟ قولوا «مع السلامة» للإنهاء.`
            : `Noted: ${upsellNote}. Reservations will confirm on callback. Anything else, or say “goodbye” to end?`,
        toolCalls: [
          { tool: 'update_booking_fields', args: { specialRequests }, result: 'upsell noted' },
          {
            tool: 'create_desk_notification',
            args: {
              subject: `Add-on request: ${booking.guestName || 'Guest'}`,
              body: `ADD-ON: ${upsellNote}. Guest ${booking.guestName || '-'} · ${booking.phone || '-'} · stay ${booking.checkIn || '-'} to ${booking.checkOut || '-'}`,
            },
            result: 'Desk notified of add-on',
          },
        ],
        nextStep: 'completed',
        bookingUpdates: { specialRequests },
        intent: 'reservation',
        createNotification: {
          subject: `Add-on request: ${booking.guestName || 'Guest'}`,
          body: `ADD-ON: ${upsellNote}. Guest ${booking.guestName || '-'} · ${booking.phone || '-'} · stay ${booking.checkIn || '-'} to ${booking.checkOut || '-'}`,
        },
      })
    }
    // Upsell menu decline (“none”) after an inquiry: end cleanly
    if (
      (step === 'await_intent' || step === 'completed') &&
      /^(none|no|nope|لا|بدون)\b/i.test(text.trim()) &&
      (booking.checkIn || booking.guestName)
    ) {
      return withLang(goodbyeReply(language, { ...booking, language }))
    }
  }

  // Mid-flow switch: spa/dining collect → new room booking
  if (
    (step === 'dining_details' || step === 'complaint_details') &&
    (intent === 'reservation' || isNewReservationUtterance(text))
  ) {
    const carried = {
      ...booking,
      language,
      diningNotes: '',
      guestName: parseName(text) || booking.guestName,
      phone: parsePhone(text) || booking.phone,
    }
    return withLang(handleIntent('reservation', text, language, afterHours, carried))
  }

  // During rooms/guests collect: guest counts beat FAQ (kids club, etc.)
  if (
    (step === 'collect_rooms' || step === 'collect_guests') &&
    (isGuestCountPhrase(text) || parseGuests(text).adults !== null)
  ) {
    // fall through to switch: do not FAQ-interrupt
  } else if (
    step === 'collect_special' &&
    (isSpecialRequestPhrase(text) || isEmptySpecialConfirm(text) || intent === 'confirm')
  ) {
    // fall through: late check-in / none / yes are special-slot answers, not FAQ
  } else if (
    // Multi-field dump mid-booking: extract all, do not FAQ-interrupt or keep only dates
    COLLECT_STEPS.includes(step) &&
    step !== 'dining_details' &&
    step !== 'complaint_details' &&
    step !== 'modify_collect' &&
    step !== 'confirm_summary' &&
    isMultiFieldDump(text)
  ) {
    const rich = extractRichReservation(text)
    const prefix =
      language === 'ar'
        ? `سجّلت التفاصيل.`
        : `Got it: I’ve captured the details you shared.`
    return withLang(advanceBookingReply(language, booking, rich, prefix))
  } else if (
    // Guest asks which rooms we have → numbered Erth list (erth.ae), then they pick 1 / 2 / …
    COLLECT_STEPS.includes(step) &&
    step !== 'collect_room_type' &&
    step !== 'dining_details' &&
    step !== 'complaint_details' &&
    step !== 'modify_collect' &&
    isRoomTypeQuestion(text)
  ) {
    return withLang(roomTypeReply(language))
  } else if (
    // Mid-booking FAQ / spa / dining / rates: answer briefly, then resume collect
    COLLECT_STEPS.includes(step) &&
    step !== 'dining_details' &&
    step !== 'complaint_details' &&
    step !== 'modify_collect' &&
    step !== 'confirm_summary' &&
    step !== 'collect_room_type' &&
    (intent === 'faq' || intent === 'spa' || intent === 'dining' || intent === 'rates')
  ) {
    const stayHint = parseStayDates(text)
    const dateCollect =
      (step === 'collect_check_in' || step === 'collect_check_out') &&
      (stayHint.checkIn || stayHint.checkOut || extractAllDates(text).length > 0)
    if (!dateCollect) {
      const answer =
        intent === 'rates'
          ? language === 'ar'
            ? `الأسعار تعتمد على التواريخ والإشغال، وتؤكدها الحجوزات عند الاتصال.`
            : `Rates depend on dates and occupancy; reservations confirms on callback.`
          : faqAnswerOnly(text, language)
      return withLang({
        text: answer + stepPrompt(step, language),
        toolCalls: [
          {
            tool: 'detect_intent',
            args: { intent, interruptedStep: step },
            result: `${intent} answered mid-booking`,
          },
        ],
        nextStep: step,
        bookingUpdates: {},
        intent,
      })
    }
  } else if (intent === 'rates' && !COLLECT_STEPS.includes(step)) {
    return withLang(handleIntent('rates', text, language, afterHours, { ...booking, language }))
  } else if (intent === 'faq' && COLLECT_STEPS.includes(step)) {
    const stayHint = parseStayDates(text)
    if (
      (step === 'collect_check_in' || step === 'collect_check_out') &&
      (stayHint.checkIn || stayHint.checkOut || extractAllDates(text).length > 0)
    ) {
      // fall through to date collection
    } else if (step === 'collect_special' && (isSpecialRequestPhrase(text) || isEmptySpecialConfirm(text))) {
      // fall through
    } else {
      const answer = faqReply(text, language)
      return withLang({
        text: answer + stepPrompt(step, language),
        toolCalls: [
          {
            tool: 'detect_intent',
            args: { intent: 'faq', interruptedStep: step },
            result: matchFaq(text) || 'faq',
          },
        ],
        nextStep: step,
        bookingUpdates: {},
        intent: 'faq',
      })
    }
  } else if (intent === 'rates') {
    return withLang(handleIntent('rates', text, language, afterHours, { ...booking, language }))
  }

  switch (step) {
    case 'idle':
    case 'greeted':
    case 'await_intent':
      return withLang(handleIntent(intent, text, language, afterHours, { ...booking, language }))

    case 'collect_check_in': {
      // Multi-field dump (dates + guests + name + phone, etc.)
      if (isMultiFieldDump(text)) {
        const rich = extractRichReservation(text)
        const prefix =
          language === 'ar' ? 'سجّلت التفاصيل.' : 'Got it: I’ve captured the details you shared.'
        return withLang(advanceBookingReply(language, booking, rich, prefix))
      }
      if (intent === 'faq' && !parseStayDates(text).checkIn) {
        return withLang({
          text: faqReply(text, language) + stepPrompt(step, language),
          toolCalls: [{ tool: 'detect_intent', args: { intent: 'faq' }, result: 'faq' }],
          nextStep: step,
          bookingUpdates: {},
        })
      }
      const stay = parseStayDates(text)
      const rich = extractRichReservation(text)
      const d = stay.checkIn || rich.checkIn
      if (!d) {
        return withLang({
          text:
            language === 'ar'
              ? 'متى تاريخ الوصول؟ يمكنكم قول غداً، بعد يومين، أو 10/10/2026.'
              : 'What is your check-in date? You can say tomorrow, in 2 days, 10/10/2026, or 2026-10-10.',
          toolCalls: [{ tool: 'update_booking_fields', args: { field: 'checkIn', raw: text }, result: 'Could not parse date' }],
          nextStep: 'collect_check_in',
          bookingUpdates: {},
        })
      }
      const arrivalNote = stay.arrivalTime
        ? language === 'ar'
          ? `وصول حوالي ${stay.arrivalTime}`
          : `Arrival around ${stay.arrivalTime}`
        : ''
      const specialFromArrival = arrivalNote
        ? { specialRequests: [booking.specialRequests, rich.specialRequests, arrivalNote].filter(Boolean).join('; ') }
        : rich.specialRequests
          ? { specialRequests: [booking.specialRequests, rich.specialRequests].filter(Boolean).join('; ') }
          : {}
      const checkOut = stay.checkOut || rich.checkOut || ''
      const patch: Partial<BookingFields> = {
        checkIn: d,
        ...(checkOut ? { checkOut } : {}),
        ...specialFromArrival,
        ...(rich.adults != null ? { adults: rich.adults } : {}),
        ...(rich.children != null ? { children: rich.children } : {}),
        ...(rich.guestName ? { guestName: rich.guestName } : {}),
        ...(rich.phone ? { phone: rich.phone } : {}),
        ...(rich.rooms != null ? { rooms: rich.rooms } : {}),
      }
      const prefix = checkOut
        ? language === 'ar'
          ? `تمام، من ${fmtDate(d, 'ar')} إلى ${fmtDate(checkOut, 'ar')}${arrivalNote ? ` (${arrivalNote})` : ''}.`
          : `Thank you, ${fmtDate(d)} to ${fmtDate(checkOut)}${arrivalNote ? ` (${arrivalNote})` : ''}.`
        : language === 'ar'
          ? `تمام، الوصول ${fmtDate(d, 'ar')}${arrivalNote ? ` (${arrivalNote})` : ''}.`
          : `Thank you, check-in ${fmtDate(d)}${arrivalNote ? ` (${arrivalNote})` : ''}.`
      if (!checkOut) {
        return withLang({
          text: prefix + (language === 'ar' ? ' وما تاريخ المغادرة؟' : ' And your check-out date?'),
          toolCalls: [{ tool: 'update_booking_fields', args: patch as Record<string, unknown>, result: 'checkIn set' }],
          nextStep: 'collect_check_out',
          bookingUpdates: patch,
          intent: 'reservation',
        })
      }
      return withLang(advanceBookingReply(language, booking, patch, prefix))
    }

    case 'collect_check_out': {
      if (isMultiFieldDump(text)) {
        const rich = extractRichReservation(text)
        const prefix =
          language === 'ar' ? 'سجّلت التفاصيل.' : 'Got it: I’ve captured the details you shared.'
        return withLang(advanceBookingReply(language, booking, rich, prefix))
      }
      // Prefer full stay parse so "check-in X check-out Y" and ranges both stick
      const stay = parseStayDates(text)
      let d = stay.checkOut || null
      if (!d && stay.checkIn && booking.checkIn && stay.checkIn !== booking.checkIn) {
        d = stay.checkOut
      }
      if (!d && stay.checkIn && !stay.checkOut) {
        d = stay.checkIn
      }
      const nights = text.match(/\b(\d+)\s*nights?\b/i) || text.match(/(\d+)\s*ليال/) || text.match(/\bafter\s+(\d+)\s*nights?\b/i)
      if (nights && booking.checkIn) {
        const [y, m, day] = booking.checkIn.split('-').map((x) => parseInt(x, 10))
        d = addDays(new Date(y, m - 1, day, 12), parseInt(nights[1], 10))
      }
      const forDays = text.match(/\b(?:for\s+)?(\d+)\s*days?\b/i)
      if (!d && forDays && booking.checkIn) {
        const [y, m, day] = booking.checkIn.split('-').map((x) => parseInt(x, 10))
        d = addDays(new Date(y, m - 1, day, 12), parseInt(forDays[1], 10))
      }
      if (!d) {
        const wd = text.match(/\b(sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs(?:day)?)?|fri(?:day)?|sat(?:urday)?)\b/i)
        if (wd && booking.checkIn) {
          const [y, m, day] = booking.checkIn.split('-').map((x) => parseInt(x, 10))
          d = nextWeekday(wd[1], new Date(y, m - 1, day, 12))
        }
      }
      if (!d) {
        d = parseDate(text)
      }
      if (!d) {
        return withLang({
          text:
            language === 'ar'
              ? 'ما تاريخ المغادرة؟ مثلاً بعد 3 ليال أو 13/10/2026.'
              : 'And the check-out date? For example after 3 nights, Friday, or 13/10/2026.',
          toolCalls: [{ tool: 'update_booking_fields', args: { field: 'checkOut', raw: text }, result: 'Could not parse date' }],
          nextStep: 'collect_check_out',
          bookingUpdates: stay.checkIn && stay.checkIn !== booking.checkIn ? { checkIn: stay.checkIn } : {},
        })
      }
      const rich = extractRichReservation(text)
      const patch: Partial<BookingFields> = {
        ...(stay.checkIn && stay.checkOut ? { checkIn: stay.checkIn } : {}),
        checkOut: d,
        ...(rich.adults != null ? { adults: rich.adults } : {}),
        ...(rich.children != null ? { children: rich.children } : {}),
        ...(rich.guestName ? { guestName: rich.guestName } : {}),
        ...(rich.phone ? { phone: rich.phone } : {}),
      }
      const prefix =
        language === 'ar' ? `المغادرة ${fmtDate(d, 'ar')}.` : `Check-out ${fmtDate(d)}.`
      return withLang(advanceBookingReply(language, booking, patch, prefix))
    }

    case 'collect_rooms': {
      if (isMultiFieldDump(text)) {
        const rich = extractRichReservation(text)
        // Keep implied room if dump didn't state rooms
        if (rich.rooms == null && booking.rooms != null) rich.rooms = booking.rooms
        return withLang(
          advanceBookingReply(
            language,
            booking,
            rich,
            language === 'ar' ? 'سجّلت التفاصيل.' : 'Got it: I’ve captured the details you shared.',
          ),
        )
      }
      // Guest count said on rooms step: save guests; keep rooms=1 if already implied, else ask rooms
      if (isGuestCountPhrase(text) || parseGuests(text).adults !== null) {
        const g = parseGuests(text)
        const layout = parseRoomLayout(text)
        const adults = g.adults ?? 2
        const children = g.children ?? 0
        const impliedRoom = layout.rooms ?? booking.rooms ?? null
        const specialRequests = layout.note
          ? [booking.specialRequests, layout.note].filter(Boolean).join('; ')
          : booking.specialRequests
        const layoutBit = layout.note
          ? language === 'ar'
            ? ` (${layout.note})`
            : `: ${layout.note}`
          : ''
        if (impliedRoom != null) {
          return withLang({
            text:
              language === 'ar'
                ? `سجّلت ${adults} بالغين و ${children} أطفال، ${impliedRoom} غرفة${layoutBit}. ما اسم الضيف للحجز؟`
                : `Noted ${adults} adult${adults === 1 ? '' : 's'} and ${children} child${children === 1 ? '' : 'ren'}, ${impliedRoom} room${impliedRoom === 1 ? '' : 's'}${layoutBit}. May I have the guest name?`,
            toolCalls: [
              {
                tool: 'update_booking_fields',
                args: { adults, children, rooms: impliedRoom, ...(specialRequests ? { specialRequests } : {}) },
                result: 'guests set; rooms kept',
              },
            ],
            nextStep: 'collect_name',
            bookingUpdates: {
              adults,
              children,
              rooms: impliedRoom,
              ...(specialRequests ? { specialRequests } : {}),
            },
            intent: 'reservation',
          })
        }
        return withLang({
          text:
            language === 'ar'
              ? `سجّلت ${adults} بالغين و ${children} أطفال. كم عدد الغرف؟ مثلاً غرفة لكل زوجين، أو غرفة للزوجين وغرفة للعائلة.`
              : `Noted ${adults} adult${adults === 1 ? '' : 's'}${children ? ` and ${children} child${children === 1 ? '' : 'ren'}` : ''}. How many rooms: e.g. one per couple, or one couple room plus one family room?`,
          toolCalls: [
            {
              tool: 'update_booking_fields',
              args: { adults, children, ...(specialRequests ? { specialRequests } : {}) },
              result: 'guests set on rooms step',
            },
          ],
          nextStep: 'collect_rooms',
          bookingUpdates: { adults, children, ...(specialRequests ? { specialRequests } : {}) },
          intent: 'reservation',
        })
      }
      const layout = parseRoomLayout(text)
      const rooms = layout.rooms ?? parseRooms(text)
      if (rooms === null) {
        // Rooms already known from “room pls”: skip re-ask (safety net)
        if (booking.rooms != null) {
          return withLang(
            advanceBookingReply(language, booking, {}, language === 'ar' ? 'حسناً.' : 'Alright.'),
          )
        }
        return withLang({
          text:
            language === 'ar'
              ? 'كم عدد الغرف؟ مثلاً غرفة واحدة، أو غرفتان منفصلتان (للزوجين وللأطفال).'
              : 'How many rooms would you like? For example “one room”, or “two separate rooms: one for the couple and one for the children”.',
          toolCalls: [{ tool: 'update_booking_fields', args: { field: 'rooms', raw: text }, result: 'Could not parse rooms' }],
          nextStep: 'collect_rooms',
          bookingUpdates: {},
        })
      }
      const specialRequests = layout.note
        ? [booking.specialRequests, layout.note].filter(Boolean).join('; ')
        : undefined
      const layoutHint =
        language === 'ar'
          ? layout.note
            ? ' سجّلت ترتيب الغرف للمكتب.'
            : ''
          : layout.note
            ? ' I’ve noted the room layout for the desk.'
            : ''
      // Guests already captured earlier → skip collect_guests
      if (booking.adults !== null && booking.adults !== undefined) {
        return withLang({
          text:
            language === 'ar'
              ? `${rooms} غرفة.${layoutHint} ما اسم الضيف للحجز؟`
              : `${rooms} room${rooms === 1 ? '' : 's'}.${layoutHint} May I have the guest name for the reservation?`,
          toolCalls: [
            {
              tool: 'update_booking_fields',
              args: { rooms, ...(specialRequests ? { specialRequests } : {}) },
              result: 'rooms set',
            },
          ],
          nextStep: 'collect_name',
          bookingUpdates: { rooms, ...(specialRequests ? { specialRequests } : {}) },
        })
      }
      return withLang({
        text:
          language === 'ar'
            ? `${rooms} غرفة.${layoutHint} كم عدد البالغين والأطفال؟ مثلاً زوجان، أو بالغ وطفلين، أو مع الأجداد.`
            : `${rooms} room${rooms === 1 ? '' : 's'}.${layoutHint} Who is staying: e.g. 2 adults, 1 adult + 2 children, or couple with grandparents?`,
        toolCalls: [
          {
            tool: 'update_booking_fields',
            args: { rooms, ...(specialRequests ? { specialRequests } : {}) },
            result: 'rooms set',
          },
        ],
        nextStep: 'collect_guests',
        bookingUpdates: { rooms, ...(specialRequests ? { specialRequests } : {}) },
      })
    }

    case 'collect_room_type': {
      if (isRoomTypeQuestion(text)) {
        return withLang(roomTypeReply(language))
      }
      const chosen = parseRoomTypeChoice(text)
      if (!chosen) {
        return withLang({
          text:
            language === 'ar'
              ? 'لم أتضح الاختيار. ' + formatRoomTypeMenu('ar')
              : 'I didn’t catch that. ' + formatRoomTypeMenu('en'),
          toolCalls: [{ tool: 'update_booking_fields', args: { field: 'roomCategory', raw: text }, result: 'Could not parse room type' }],
          nextStep: 'collect_room_type',
          bookingUpdates: {},
        })
      }
      const prefix =
        language === 'ar'
          ? `تمام: سجّلت تفضيلكم: ${chosen}.`
          : `Got it: I’ll note ${chosen} as your preference.`
      return withLang(
        advanceBookingReply(language, booking, { roomCategory: chosen, rooms: booking.rooms ?? 1 }, prefix),
      )
    }

    case 'collect_guests': {
      if (isMultiFieldDump(text)) {
        const rich = extractRichReservation(text)
        if (rich.rooms == null && booking.rooms != null) rich.rooms = booking.rooms
        return withLang(
          advanceBookingReply(
            language,
            booking,
            rich,
            language === 'ar' ? 'سجّلت التفاصيل.' : 'Got it: I’ve captured the details you shared.',
          ),
        )
      }
      // "one room" on guests step → correct rooms, re-ask guests
      if (isRoomsOnlyPhrase(text)) {
        const rooms = parseRooms(text) ?? 1
        return withLang({
          text:
            language === 'ar'
              ? `حسناً، ${rooms} غرفة. كم عدد البالغين والأطفال؟`
              : `Got it: ${rooms} room${rooms === 1 ? '' : 's'}. How many adults and children?`,
          toolCalls: [{ tool: 'update_booking_fields', args: { rooms }, result: 'rooms corrected on guests step' }],
          nextStep: 'collect_guests',
          bookingUpdates: { rooms },
        })
      }
      const g = parseGuests(text)
      if (g.adults === null) {
        return withLang({
          text:
            language === 'ar'
              ? 'من سيقيم؟ مثلاً زوجان، أو زوجان اثنان (غرفتان)، أو زوجان مع عائلة وطفلين.'
              : 'Who is staying? For example “1 couple”, “2 couples” (two couple rooms), or “1 couple and a family with 2 children”.',
          toolCalls: [{ tool: 'update_booking_fields', args: { field: 'guests', raw: text }, result: 'Could not parse guests' }],
          nextStep: 'collect_guests',
          bookingUpdates: {},
        })
      }
      const adults = g.adults
      const children = g.children ?? 0
      const layout = parseRoomLayout(text)
      const roomsUpdate =
        layout.rooms != null && (booking.rooms == null || layout.rooms > (booking.rooms ?? 0))
          ? layout.rooms
          : undefined
      const specialRequests = layout.note
        ? [booking.specialRequests, layout.note].filter(Boolean).join('; ')
        : undefined
      const layoutBit = layout.note ? (language === 'ar' ? `: ${layout.note}` : `: ${layout.note}`) : ''
      return withLang({
        text:
          language === 'ar'
            ? `${adults} بالغين و ${children} أطفال${roomsUpdate != null ? `، ${roomsUpdate} غرفة` : ''}${layoutBit}. ما اسم الضيف للحجز؟`
            : `${adults} adult${adults === 1 ? '' : 's'} and ${children} child${children === 1 ? '' : 'ren'}${roomsUpdate != null ? `, ${roomsUpdate} room${roomsUpdate === 1 ? '' : 's'}` : ''}${layoutBit}. May I have the guest name for the reservation?`,
        toolCalls: [
          {
            tool: 'update_booking_fields',
            args: {
              adults,
              children,
              ...(roomsUpdate != null ? { rooms: roomsUpdate } : {}),
              ...(specialRequests ? { specialRequests } : {}),
            },
            result: 'guests set',
          },
        ],
        nextStep: 'collect_name',
        bookingUpdates: {
          adults,
          children,
          ...(roomsUpdate != null ? { rooms: roomsUpdate } : {}),
          ...(specialRequests ? { specialRequests } : {}),
        },
      })
    }

    case 'collect_name': {
      const name = parseName(text)
      if (!name) {
        return withLang({
          text: language === 'ar' ? 'ما الاسم الكامل من فضلك؟' : 'May I have the full guest name, please?',
          toolCalls: [{ tool: 'update_booking_fields', args: { field: 'guestName', raw: text }, result: 'Could not parse name' }],
          nextStep: 'collect_name',
          bookingUpdates: {},
        })
      }
      return withLang({
        text:
          language === 'ar'
            ? `شكراً ${name}. وما رقم الهاتف للتواصل؟`
            : `Thank you, ${name}. And a mobile number we can reach you on?`,
        toolCalls: [{ tool: 'update_booking_fields', args: { guestName: name }, result: 'guestName set' }],
        nextStep: 'collect_phone',
        bookingUpdates: { guestName: name },
      })
    }

    case 'collect_phone': {
      const phone = parsePhone(text) || text.trim()
      return withLang({
        text:
          language === 'ar'
            ? 'هل هناك طلبات خاصة؟ مثل تسجيل وصول متأخر أو نوع غرفة. يمكنكم قول «لا».'
            : 'Any special requests, for example late check-in, connecting rooms, or accessibility needs? You may say “none”.',
        toolCalls: [{ tool: 'update_booking_fields', args: { phone }, result: 'phone set' }],
        nextStep: 'collect_special',
        bookingUpdates: { phone },
      })
    }

    case 'collect_special': {
      let special = ''
      if (isEmptySpecialConfirm(text) || intent === 'confirm') {
        special = ''
      } else if (isSpecialRequestPhrase(text) || text.trim().length > 0) {
        special = normalizeSpecialRequest(text)
      }
      const next: BookingFields = { ...booking, specialRequests: special, language }
      return withLang({
        text: buildConfirmText(next, language),
        toolCalls: [
          { tool: 'update_booking_fields', args: { specialRequests: special }, result: 'specialRequests set' },
          { tool: 'confirm_booking_summary', args: { summary: buildBookingSummary(next) }, result: 'Awaiting guest confirmation' },
        ],
        nextStep: 'confirm_summary',
        bookingUpdates: { specialRequests: special },
      })
    }

    case 'confirm_summary': {
      if (intent === 'deny') {
        return withLang({
          text:
            language === 'ar'
              ? 'حسناً، لنعدّل التفاصيل. ما تاريخ الوصول الصحيح؟'
              : 'Of course, let’s correct that. What is the check-in date?',
          toolCalls: [{ tool: 'update_booking_fields', args: { action: 'revise' }, result: 'Restarting collection' }],
          nextStep: 'collect_check_in',
          bookingUpdates: {},
        })
      }
      const isYes =
        intent === 'confirm' ||
        /\b(yes|yeah|correct|confirm|ok|okay|please|go ahead|that'?s? (right|correct|fine))\b/i.test(text) ||
        /^(نعم|أجل|ايوه|أيوه|تمام|أكد|موافق|صح)/.test(text.trim())
      if (isYes) {
        return withLang(finalizeBooking(booking, language, afterHours))
      }
      if ((intent === 'unknown' || intent === 'reservation') && text.length < 40 && !/\b(no|wrong|لا)\b/i.test(text)) {
        return withLang(finalizeBooking(booking, language, afterHours))
      }
      return withLang({
        text:
          language === 'ar'
            ? 'هل تؤكد هذه التفاصيل؟ قولوا نعم للمتابعة أو لا للتعديل.'
            : 'Shall I confirm these details with reservations? Please say yes to proceed, or no to make a change.',
        toolCalls: [{ tool: 'confirm_booking_summary', args: {}, result: 'Still awaiting confirmation' }],
        nextStep: 'confirm_summary',
        bookingUpdates: {},
      })
    }

    case 'modify_collect': {
      const conf =
        text.match(/\b(?:conf(?:irmation)?(?:\s*(?:no|number|#))?[:\s-]*)([A-Z0-9-]{4,})\b/i)?.[1] ||
        text.match(/\b(ERTH-?[A-Z0-9]{4,}|\d{6,})\b/i)?.[1] ||
        booking.confirmationNumber ||
        ''
      const phone = parsePhone(text) || booking.phone
      const nameGuess = parseName(text)
      const name = (nameGuess && nameGuess.length > 2 ? nameGuess : '') || booking.guestName
      const dateHint = parseDate(text) || booking.checkIn
      // Ask once for confirmation if still missing, but still allow callback
      if (!conf && !dateHint && !booking.confirmationNumber && !/no conf|don't have|بدون رقم|ما عندي/i.test(text)) {
        const partial = {
          guestName: name || booking.guestName,
          phone: phone || booking.phone,
          modifyRequest: text.trim(),
        }
        return withLang({
          text:
            language === 'ar'
              ? 'شكراً. إن وُجد رقم التأكيد أرسلوه الآن، أو قولوا «بدون رقم» مع تاريخ الوصول وسنطلب من الحجوزات الاتصال بكم للتحقق.'
              : 'Thank you. If you have a confirmation number, please share it now. Or say “no confirmation” with your check-in date and we will still ask reservations to call you back after verifying.',
          toolCalls: [
            { tool: 'detect_intent', args: { intent: 'modify' }, result: 'modify: asked confirmation once' },
            { tool: 'update_booking_fields', args: partial as Record<string, unknown>, result: 'partial modify fields' },
          ],
          nextStep: 'modify_collect',
          bookingUpdates: partial,
          intent: 'modify',
        })
      }
      return withLang(
        finalizeModifyRequest(language, {
          ...booking,
          guestName: name || booking.guestName || 'Guest',
          phone: phone || booking.phone,
          confirmationNumber: conf,
          checkIn: dateHint || booking.checkIn,
          modifyRequest: [booking.modifyRequest, text.trim()].filter(Boolean).join(' | '),
        }),
      )
    }

    case 'dining_details': {
      // Switch already handled above; finalize dining/spa or extract one-shot
      const extracted = extractDiningDetails(text, booking)
      const isSpa = /spa|massage|سبا|مساج/i.test(booking.diningNotes || '') || /spa|سبا/i.test(text)
      const name = extracted.guestName || booking.guestName || ''
      const phone = extracted.phone || booking.phone || ''
      const notes = extracted.notes

      const missing: string[] = []
      if (!extracted.party && !/\d+\s*(people|guests?|pax|أشخاص)/i.test(booking.diningNotes || '')) {
        if (!extracted.party) missing.push(language === 'ar' ? 'عدد الأشخاص' : 'party size')
      }
      if (!extracted.date && !extracted.time) {
        missing.push(language === 'ar' ? 'التاريخ أو الوقت' : 'date or time')
      }

      // One-shot enough fields → notify immediately
      if (extracted.party && (extracted.date || extracted.time) && (name || phone || extracted.restaurant)) {
        const subject = isSpa
          ? `Spa request, ${name || 'Guest'}`
          : `Dining request, ${name || 'Guest'}${extracted.restaurant ? ` · ${extracted.restaurant}` : ''}`
        const body = [
          isSpa ? 'Spa' : 'Dining',
          `request, ${name || 'Guest'}`,
          phone ? `phone ${phone}` : 'phone not provided',
          extracted.restaurant ? extracted.restaurant : null,
          extracted.party ? `party ${extracted.party}` : null,
          extracted.date ? `date ${extracted.date}` : null,
          extracted.time ? `time ${extracted.time}` : null,
          `notes: ${notes}`,
          'please call back to confirm.',
        ]
          .filter(Boolean)
          .join(', ')
        return withLang({
          text:
            language === 'ar'
              ? 'تم تسجيل الطلب وإشعار الاستقبال. هل تحتاجون شيئاً آخر؟'
              : 'I’ve noted your request and notified the desk. They will confirm shortly. Is there anything else I can help with?',
          toolCalls: [
            { tool: 'update_booking_fields', args: extracted as Record<string, unknown>, result: 'dining fields saved' },
            { tool: 'create_desk_notification', args: { subject, body }, result: 'Desk notified' },
            { tool: 'end_conversation', args: {}, result: 'Request saved' },
          ],
          nextStep: 'completed',
          bookingUpdates: {
            guestName: name || booking.guestName,
            phone: phone || booking.phone,
            diningNotes: notes,
            diningDate: extracted.date || booking.diningDate,
            diningTime: extracted.time || booking.diningTime,
            diningParty: extracted.party ?? booking.diningParty,
          },
          outcome: afterHours ? 'after_hours_saved' : 'booked_inquiry',
          createNotification: { subject, body },
          end: true,
        })
      }

      if (missing.length && text.trim().length < 80 && !extracted.party) {
        return withLang({
          text:
            language === 'ar'
              ? `من فضلكم: ${missing.join(' و ')}.`
              : `Please share ${missing.join(' and ')} (and restaurant if you have a preference).`,
          toolCalls: [{ tool: 'update_booking_fields', args: extracted as Record<string, unknown>, result: 'partial dining' }],
          nextStep: 'dining_details',
          bookingUpdates: {
            guestName: name || booking.guestName,
            phone: phone || booking.phone,
            diningNotes: notes || booking.diningNotes,
            diningDate: extracted.date || booking.diningDate,
            diningTime: extracted.time || booking.diningTime,
            diningParty: extracted.party ?? booking.diningParty,
          },
        })
      }

      const subject = isSpa ? `Spa request, ${name || booking.guestName || 'Guest'}` : `Dining request, ${name || booking.guestName || 'Guest'}`
      const body = `${isSpa ? 'Spa' : 'Dining'} request, ${name || booking.guestName || 'Guest'}, ${notes}, phone ${phone || booking.phone || 'not provided'}, please call back to confirm.`
      return withLang({
        text:
          language === 'ar'
            ? 'تم تسجيل الطلب وإشعار الاستقبال. هل تحتاجون شيئاً آخر؟'
            : 'I’ve noted your request and notified the desk. They will confirm shortly. Is there anything else I can help with?',
        toolCalls: [
          { tool: 'update_booking_fields', args: { diningNotes: notes }, result: 'notes saved' },
          { tool: 'create_desk_notification', args: { subject, body }, result: 'Desk notified' },
          { tool: 'end_conversation', args: {}, result: 'Request saved' },
        ],
        nextStep: 'completed',
        bookingUpdates: {
          diningNotes: notes,
          guestName: name || booking.guestName,
          phone: phone || booking.phone,
        },
        outcome: afterHours ? 'after_hours_saved' : 'booked_inquiry',
        createNotification: { subject, body },
        end: true,
      })
    }

    case 'complaint_details': {
      return withLang(buildComplaintResolution(text, language, booking))
    }

    case 'escalated':
    case 'completed': {
      if (intent === 'goodbye' || isGoodbyePhrase(text)) {
        return withLang(goodbyeReply(language, { ...booking, language }))
      }
      // Allow new questions after completion without forcing reset
      if (intent === 'faq' || intent === 'reservation' || intent === 'dining' || intent === 'spa' || intent === 'modify' || intent === 'complaint') {
        return withLang(handleIntent(intent, text, language, afterHours, { ...booking, language }))
      }
      return withLang({
        text:
          language === 'ar'
            ? 'يسعدني المساعدة أكثر, حجز، سؤال عن المنتجع، أو التحويل لزميل. لإنهاء المكالمة قولوا «مع السلامة». أو ابدأوا محادثة جديدة من لوحة التحكم.'
            : 'Happy to help further: another reservation, a resort question, or a colleague. Say “goodbye” to end the call, or start a fresh demo from the dashboard.',
        toolCalls: [],
        nextStep: 'completed',
        bookingUpdates: {},
      })
    }

    default:
      return withLang(handleIntent(intent, text, language, afterHours, { ...booking, language }))
  }
}

function finalizeModifyRequest(language: Language, booking: BookingFields): AgentReply {
  const subject = 'Booking change request: verify then call guest'
  const body = [
    'CHANGE/CANCEL inquiry only (do not treat as confirmed modification).',
    `Guest: ${booking.guestName || '-'}`,
    `Phone: ${booking.phone || '-'}`,
    `Confirmation: ${booking.confirmationNumber || 'not provided'}`,
    `Check-in on file: ${booking.checkIn || '-'}`,
    `Request: ${booking.modifyRequest || '-'}`,
    'Action: verify booking then call guest back.',
  ].join(' · ')

  return {
    text:
      language === 'ar'
        ? 'تم. سجّلت طلب التعديل/الإلغاء وأشعرت مكتب الحجوزات للتحقق ثم الاتصال بكم. لم يتم تغيير أي حجز فعلي من هذه القناة. هل تحتاجون شيئاً آخر؟'
        : 'Done. I’ve logged your change request and notified reservations to verify the booking and call you back. No live reservation was changed from this channel. Is there anything else I can help with?',
    toolCalls: [
      { tool: 'detect_intent', args: { intent: 'modify' }, result: 'modify' },
      {
        tool: 'update_booking_fields',
        args: {
          guestName: booking.guestName,
          phone: booking.phone,
          confirmationNumber: booking.confirmationNumber,
          checkIn: booking.checkIn,
          modifyRequest: booking.modifyRequest,
        },
        result: 'modify inquiry fields saved',
      },
      { tool: 'create_desk_notification', args: { subject, body }, result: 'Desk notified - change request' },
    ],
    nextStep: 'completed',
    bookingUpdates: {
      guestName: booking.guestName,
      phone: booking.phone,
      confirmationNumber: booking.confirmationNumber,
      checkIn: booking.checkIn,
      modifyRequest: booking.modifyRequest,
    },
    intent: 'modify',
    outcome: 'callback_requested',
    createNotification: { subject, body },
    createTicket: {
      reason: 'Booking change / cancel request',
      summary: booking.modifyRequest || 'Guest requested change or cancel - verify then callback',
      priority: 'normal',
    },
    end: true,
  }
}

function escalateReply(language: Language, booking: BookingFields): AgentReply {
  return {
    text:
      language === 'ar'
        ? 'بالتأكيد. سأحوّلكم إلى زميل في الحجوزات وأترك ملخصاً قصيراً للمحادثة.'
        : 'Of course. I’ll connect you with a reservations colleague and leave a short summary of our conversation.',
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
      reason: 'Guest requested human agent',
      summary: 'Warm handoff - guest asked for a colleague',
      priority: 'normal',
    },
    end: true,
  }
}

function handleIntent(
  intent: Intent,
  text: string,
  language: Language,
  afterHours: boolean,
  booking: BookingFields,
): AgentReply {
  switch (intent) {
    case 'human':
      return escalateReply(language, booking)

    case 'complaint': {
      if (isActionableComplaint(text)) {
        return buildComplaintResolution(text, language, booking)
      }
      const nameFromText = parseName(text) || booking.guestName || ''
      const phoneFromText = parsePhone(text) || booking.phone || ''
      return {
        text:
          language === 'ar'
            ? 'أعتذر بصدق. من فضلكم صفوا المشكلة ورقم الغرفة إن وُجد (مثلاً: المكيف لا يعمل في الغرفة ٤١٢). سأفتح تذكرة بأولوية عالية.'
            : 'I’m truly sorry. Please share what’s wrong and the room number if you have it: for example “AC not working in room 412”. I’ll open a priority ticket for the desk.',
        toolCalls: [{ tool: 'detect_intent', args: { intent: 'complaint' }, result: 'complaint, collecting details' }],
        nextStep: 'complaint_details',
        bookingUpdates: {
          guestName: nameFromText || booking.guestName,
          phone: phoneFromText || booking.phone,
        },
        intent: 'complaint',
      }
    }

    case 'rates': {
      return {
        text:
          language === 'ar'
            ? `الأسعار تعتمد على التواريخ والإشغال، وتؤكدها الحجوزات عند الاتصال (${RESORT.reservationsPhone}). يمكنني تسجيل استفسار الآن أو تحويلكم لزميل. هل تودون تسجيل طلب؟`
            : `Rates depend on dates and occupancy; reservations confirms the final rate on callback (${RESORT.reservationsPhone}). I don’t invent prices here. I can take a structured inquiry now, or connect you to a colleague: would you like me to start an inquiry?`,
        toolCalls: [{ tool: 'detect_intent', args: { intent: 'rates' }, result: 'rates explained: no booking form yet' }],
        nextStep: 'await_intent',
        bookingUpdates: {},
        intent: 'rates',
      }
    }

    case 'confirm': {
      // “Yes” after rates / “start inquiry?”: begin booking collect
      return {
        text:
          language === 'ar'
            ? 'حسناً: نسجّل استفسار الحجز. ما تاريخ الوصول؟'
            : 'Great: I’ll take a reservation inquiry. What is your check-in date?',
        toolCalls: [{ tool: 'detect_intent', args: { intent: 'reservation', from: 'confirm' }, result: 'started inquiry' }],
        nextStep: 'collect_check_in',
        bookingUpdates: {},
        intent: 'reservation',
      }
    }

    case 'goodbye':
      return goodbyeReply(language, booking)

    case 'reservation': {
      if (isRoomTypeQuestion(text)) {
        return roomTypeReply(language)
      }
      const updates = extractRichReservation(text)
      const avail = isAvailabilityOrConfirmNow(text)
      // “start the enquiry” with no dates/name yet → open collect. If they already dumped fields, extract them.
      if (
        (isIncompleteBookingLead(text) || isStartInquiryPhrase(text)) &&
        Object.keys(updates).length === 0
      ) {
        return {
          text:
            language === 'ar'
              ? 'حاضر: طلب حجز. متى تاريخ الوصول؟ أو أخبروني بعدد الضيوف، أو اسألوا عن أنواع الغرف.'
              : 'Of course: a reservation. What check-in date are you looking at? You can also say who is staying, or ask which room types we have.',
          toolCalls: [
            { tool: 'detect_intent', args: { intent: 'reservation', incomplete: true }, result: 'waiting for details' },
          ],
          nextStep: 'collect_check_in',
          bookingUpdates: {},
          intent: 'reservation',
        }
      }

      if (updates.checkIn && updates.checkOut && updates.guestName && updates.phone) {
        const merged = { ...booking, ...updates, rooms: updates.rooms ?? 1, language }
        return {
          text:
            (language === 'en'
              ? avail
                ? 'I can’t confirm live inventory or finalize a booking from this channel: reservations verifies availability. I can log a structured inquiry with what you shared. '
                : 'I’d be glad to help with a reservation. '
              : avail
                ? 'لا أؤكد التوفر أو الحجز النهائي من هذه القناة: الحجوزات تتحقق. يمكنني تسجيل استفسار بالتفاصيل. '
                : 'يسعدني المساعدة في الحجز. ') + buildConfirmText(merged, language),
          toolCalls: [
            { tool: 'detect_intent', args: { intent: 'reservation', availability: avail }, result: 'reservation' },
            { tool: 'update_booking_fields', args: updates as Record<string, unknown>, result: 'Multiple fields extracted' },
            { tool: 'confirm_booking_summary', args: { summary: buildBookingSummary(merged) }, result: 'Awaiting confirmation' },
          ],
          nextStep: 'confirm_summary',
          bookingUpdates: merged,
          intent: 'reservation',
        }
      }

      // Availability / confirm-now with partial fields: extract and enter collect path
      if (avail || Object.keys(updates).length > 0) {
        const merged = {
          ...booking,
          ...updates,
          rooms: updates.rooms ?? booking.rooms,
          adults: updates.adults ?? booking.adults,
          children: updates.children ?? booking.children,
          language,
        }
        const nextStep: ConversationStep = !merged.checkIn
          ? 'collect_check_in'
          : !merged.checkOut
            ? 'collect_check_out'
            : merged.rooms == null
              ? 'collect_rooms'
              : merged.adults == null
                ? 'collect_guests'
                : !merged.guestName
                  ? 'collect_name'
                  : !merged.phone
                    ? 'collect_phone'
                    : 'confirm_summary'

        const honest =
          avail
            ? language === 'ar'
              ? 'التوفر الحي يؤكده مكتب الحجوزات فقط: لن أؤكد الحجز الآن. سأسجّل استفساراً منظماً للاتصال بكم. '
              : 'Live availability is confirmed by reservations only: I won’t confirm a booking from this channel. I can log a structured inquiry for callback. '
            : ''

        const ask =
          nextStep === 'confirm_summary'
            ? buildConfirmText(merged as BookingFields, language)
            : nextStep === 'collect_rooms'
              ? language === 'ar'
                ? `التواريخ ${fmtDate(merged.checkIn || '', 'ar')} إلى ${fmtDate(merged.checkOut || '', 'ar')}${merged.adults ? `، ${merged.adults} بالغين` : ''}. كم عدد الغرف؟`
                : `Got ${fmtDate(merged.checkIn || '')} to ${fmtDate(merged.checkOut || '')}${merged.adults ? ` for ${merged.adults} adults` : ''}. How many rooms?`
              : nextStep === 'collect_check_out'
                ? language === 'ar'
                  ? `وصول ${fmtDate(merged.checkIn || '', 'ar')}. وما تاريخ المغادرة؟`
                  : `Check-in ${fmtDate(merged.checkIn || '')}. And check-out?`
                : nextStep === 'collect_guests'
                  ? language === 'ar'
                    ? 'كم عدد البالغين والأطفال؟'
                    : 'How many adults and children?'
                  : nextStep === 'collect_name'
                    ? language === 'ar'
                      ? 'ما اسم الضيف؟'
                      : 'May I have the guest name?'
                    : nextStep === 'collect_phone'
                      ? language === 'ar'
                        ? 'وما رقم الهاتف؟'
                        : 'And a mobile number?'
                      : language === 'ar'
                        ? 'ما تاريخ الوصول؟'
                        : 'What is your check-in date?'

        return {
          text: honest + ask,
          toolCalls: [
            { tool: 'detect_intent', args: { intent: 'reservation', availability: avail }, result: avail ? 'availability inquiry' : 'reservation' },
            ...(Object.keys(updates).length
              ? [{ tool: 'update_booking_fields', args: updates as Record<string, unknown>, result: 'Partial fields extracted' }]
              : []),
          ],
          nextStep,
          bookingUpdates: updates,
          intent: 'reservation',
        }
      }

      return {
        text:
          language === 'ar'
            ? afterHours
              ? `يسعدني المساعدة. المكتب يفتح الساعة ${RESORT.frontDeskOpens}، وسأسجّل طلبكم الآن. ما تاريخ الوصول؟`
              : 'يسعدني المساعدة في حجز جديد. ما تاريخ الوصول؟'
            : afterHours
              ? `I’d be glad to help. Our desk opens at ${RESORT.frontDeskOpens}; I’ll take the full request now so they can confirm rates. What is your check-in date?`
              : 'I’d be glad to help with a new reservation. What is your check-in date?',
        toolCalls: [{ tool: 'detect_intent', args: { intent: 'reservation' }, result: 'reservation' }],
        nextStep: 'collect_check_in',
        bookingUpdates: {},
        intent: 'reservation',
      }
    }

    case 'modify': {
      const conf =
        text.match(/\b(?:conf(?:irmation)?(?:\s*(?:no|number|#))?[:\s-]*)([A-Z0-9-]{4,})\b/i)?.[1] ||
        text.match(/\b(ERTH-?[A-Z0-9]{4,}|\d{6,})\b/i)?.[1]
      const phone = parsePhone(text) || booking.phone
      const name = parseName(text) || booking.guestName || ''
      const stay = parseStayDates(text)
      const dateHint = stay.checkIn || parseDate(text) || booking.checkIn
      const ota = isOtaOrExistingBooking(text)
      // OTA / prepaid without identity → collect, do not start new booking form
      if (ota && !(conf || name || phone)) {
        return {
          text:
            language === 'ar'
              ? 'فهمت: لديكم حجز قائم أو مدفوع عبر منصة. لن أبدأ حجزاً جديداً. من فضلكم أرسلوا الاسم ورقم التأكيد (أو بريد الحجز) ورقم الهاتف، وسيتصل بكم مكتب الحجوزات بعد التحقق.'
              : 'Understood: you have an existing or prepaid OTA booking. I won’t start a new reservation. Please share the guest name, confirmation number (or booking email), and phone, and reservations will verify then call you back.',
          toolCalls: [{ tool: 'detect_intent', args: { intent: 'modify', ota: true }, result: 'OTA/existing → modify collect' }],
          nextStep: 'modify_collect',
          bookingUpdates: { modifyRequest: text.trim() },
          intent: 'modify',
        }
      }
      const hasDetail = !!(conf || dateHint || phone || (name && name.length < 40) || ota)
      if (hasDetail && text.length > 25 && (conf || phone || name || ota)) {
        const modifyRequest = ota ? `[OTA/existing] ${text.trim()}` : text.trim()
        return finalizeModifyRequest(language, {
          ...booking,
          guestName: name || booking.guestName,
          phone: phone || booking.phone,
          confirmationNumber: conf || booking.confirmationNumber || '',
          checkIn: dateHint || booking.checkIn,
          modifyRequest,
        })
      }
      return {
        text:
          language === 'ar'
            ? 'يمكنني تسجيل طلب تعديل أو إلغاء، وسيتصل بكم فريق الحجوزات بعد التحقق من الحجز. لن أعدّل حجزاً فعلياً من هذه القناة. من فضلكم أرسلوا: الاسم، رقم الهاتف، رقم التأكيد إن وُجد أو تاريخ الوصول، وما الذي تريدون تغييره.'
            : 'I can take a change request and have reservations call you back after verifying your booking. I won’t change a live reservation from this channel yet. Please share: guest name, phone, confirmation number if you have it (or check-in date), and what you want changed.',
        toolCalls: [{ tool: 'detect_intent', args: { intent: 'modify', ota }, result: 'modify: collecting details' }],
        nextStep: 'modify_collect',
        bookingUpdates: {},
        intent: 'modify',
      }
    }

    case 'dining': {
      const extracted = extractDiningDetails(text, booking)
      if (extracted.party && (extracted.date || extracted.time)) {
        const name = extracted.guestName || booking.guestName || ''
        const phone = extracted.phone || booking.phone || ''
        if (name || phone || extracted.restaurant) {
          const subject = `Dining request, ${name || 'Guest'}${extracted.restaurant ? ` · ${extracted.restaurant}` : ''}`
          const body = [
            'Dining request',
            name || 'Guest',
            phone ? `phone ${phone}` : null,
            extracted.restaurant,
            extracted.party ? `party ${extracted.party}` : null,
            extracted.date ? `date ${extracted.date}` : null,
            extracted.time ? `time ${extracted.time}` : null,
            'please call back to confirm.',
          ]
            .filter(Boolean)
            .join(', ')
          return {
            text:
              language === 'ar'
                ? 'تم تسجيل طلب المطعم وإشعار الاستقبال. هل تحتاجون شيئاً آخر؟'
                : 'I’ve logged your dining request and notified the desk. They will confirm shortly. Anything else I can help with?',
            toolCalls: [
              { tool: 'detect_intent', args: { intent: 'dining' }, result: 'dining one-shot' },
              { tool: 'update_booking_fields', args: extracted as Record<string, unknown>, result: 'dining fields' },
              { tool: 'create_desk_notification', args: { subject, body }, result: 'Desk notified' },
            ],
            nextStep: 'completed',
            bookingUpdates: {
              guestName: name || booking.guestName,
              phone: phone || booking.phone,
              diningNotes: extracted.notes,
              diningDate: extracted.date,
              diningTime: extracted.time,
              diningParty: extracted.party,
            },
            intent: 'dining',
            outcome: afterHours ? 'after_hours_saved' : 'booked_inquiry',
            createNotification: { subject, body },
            end: true,
          }
        }
      }
      return {
        text:
          language === 'ar'
            ? `بالتأكيد. يمكنكم الحجز عبر المطاعم ${RESORT.diningPhone}. لأي تاريخ ووقت وكم عدد الأشخاص؟ وأي مطعم إن أمكن.`
            : `Certainly. For tables you can also call dining on ${RESORT.diningPhone}. Which date and time, and for how many guests? If you have a preferred restaurant, please mention it.`,
        toolCalls: [{ tool: 'detect_intent', args: { intent: 'dining' }, result: 'dining' }],
        nextStep: 'dining_details',
        bookingUpdates: {
          diningNotes: 'dining',
          guestName: extracted.guestName || booking.guestName,
          phone: extracted.phone || booking.phone,
          diningDate: extracted.date || booking.diningDate,
          diningTime: extracted.time || booking.diningTime,
          diningParty: extracted.party ?? booking.diningParty,
        },
        intent: 'dining',
      }
    }

    case 'spa':
      return {
        text:
          KNOWLEDGE.spa[language] +
          (language === 'en' ? ' What day and time would you prefer?' : ' أي يوم ووقت تفضلون؟'),
        toolCalls: [{ tool: 'detect_intent', args: { intent: 'spa' }, result: 'spa' }],
        nextStep: 'dining_details',
        bookingUpdates: { diningNotes: 'spa' },
        intent: 'spa',
      }

    case 'faq':
      if (isArabicGreeting(text)) {
        const bizName = getActiveBusiness().greetingName
        return {
          text:
            language === 'ar' || /[\u0600-\u06FF]/.test(text)
              ? `وعليكم السلام ومرحباً بكم في حجوزات إرث أبوظبي. كيف يمكنني مساعدتكم: حجز، تعديل، مطعم، سبا، أو التحدث مع زميل؟`
              : `Wa alaykum as-salam: welcome to ${bizName} reservations. How may I help: a reservation, a change, dining, spa, or a colleague?`,
          toolCalls: [{ tool: 'detect_intent', args: { intent: 'greeting' }, result: 'Arabic greeting' }],
          nextStep: 'await_intent',
          bookingUpdates: { language: /[\u0600-\u06FF]/.test(text) ? 'ar' : language },
          intent: 'faq',
        }
      }
      if (isQuickQuestionLead(text)) {
        return {
          text:
            language === 'ar'
              ? 'تفضلوا: ما سؤالكم؟ مثلاً المواقف، المطار، السبا، الفطور، أو أنواع الغرف.'
              : 'Of course: what’s your question? For example parking, airport transfer, spa, breakfast, or room types.',
          toolCalls: [{ tool: 'detect_intent', args: { intent: 'faq', lead: true }, result: 'awaiting guest question' }],
          nextStep: 'await_intent',
          bookingUpdates: {},
          intent: 'faq',
        }
      }
      if (isRoomTypeQuestion(text) || matchFaq(text) === 'room_types') {
        return roomTypeReply(language)
      }
      return {
        text: faqReply(text, language),
        toolCalls: [{ tool: 'detect_intent', args: { intent: 'faq' }, result: matchFaq(text) || 'faq' }],
        nextStep: 'await_intent',
        bookingUpdates: {},
        intent: 'faq',
      }

    default: {
      if (isOffTopicChatter(text)) {
        return {
          text: OFF_TOPIC_REPLY,
          toolCalls: [{ tool: 'detect_intent', args: { intent: 'unknown', offTopic: true }, result: 'off-topic redirect' }],
          nextStep: 'await_intent',
          bookingUpdates: {},
          intent: 'unknown',
        }
      }
      if (isSimpleGreetingOnly(text)) {
        return {
          text:
            'Hello, and welcome to Erth Abu Dhabi. How may I help you today: a room reservation, a change to a booking, dining, the spa, or a colleague?',
          toolCalls: [{ tool: 'detect_intent', args: { intent: 'greeting' }, result: 'simple greeting' }],
          nextStep: 'await_intent',
          bookingUpdates: {},
          intent: 'faq',
        }
      }
      if (isDiningWithoutStay(text)) {
        return {
          text:
            language === 'ar'
              ? `بالتأكيد للمطاعم. اتصلوا على ${RESORT.diningPhone} أو أخبروني بالتاريخ والوقت وعدد الأشخاص.`
              : `Happy to help with dining. Call ${RESORT.diningPhone}, or tell me the date, time, and party size.`,
          toolCalls: [{ tool: 'detect_intent', args: { intent: 'dining' }, result: 'dining redirect' }],
          nextStep: 'dining_details',
          bookingUpdates: { diningNotes: 'dining' },
          intent: 'dining',
        }
      }
      if (isIncompleteBookingLead(text) || isStartInquiryPhrase(text)) {
        return {
          text:
            language === 'ar'
              ? 'حاضر: أكملوا طلبكم. هل تريدون حجز إقامة؟ ما تاريخ الوصول؟'
              : 'Happy to help: go ahead. Are you booking a stay? What check-in date works for you?',
          toolCalls: [{ tool: 'detect_intent', args: { intent: 'reservation', incomplete: true }, result: 'incomplete lead' }],
          nextStep: 'collect_check_in',
          bookingUpdates: {},
          intent: 'reservation',
        }
      }
      if (isRoomTypeQuestion(text)) {
        return roomTypeReply(language)
      }
      // Try FAQ anyway for unknown — but never pets on off-topic cat mentions
      const faqKey = isOffTopicChatter(text) ? null : matchFaq(text)
      if (faqKey) {
        return {
          text: faqReply(text, language),
          toolCalls: [{ tool: 'detect_intent', args: { intent: 'faq' }, result: faqKey }],
          nextStep: 'await_intent',
          bookingUpdates: {},
          intent: 'faq',
        }
      }
      return {
        text:
          language === 'ar'
            ? 'لم ألتقط ذلك بوضوح. قولوا «حجز» مع تاريخ الوصول، أو اسألوا عن المواقف/المطار/السبا، أو «موظف» للتحويل.'
            : 'I didn’t catch that clearly. Say “book a stay” with a check-in date, ask about parking / airport / spa / room types, or say “talk to a colleague”.',
        toolCalls: [{ tool: 'detect_intent', args: { intent: 'unknown', raw: text }, result: 'clarify prompt' }],
        nextStep: 'await_intent',
        bookingUpdates: {},
      }
    }
  }
}

function extractDiningDetails(
  text: string,
  booking: BookingFields,
): {
  party: number | null
  date: string
  time: string
  restaurant: string
  guestName: string
  phone: string
  notes: string
} {
  const partyMatch =
    text.match(/\b(?:table\s+for|for|party\s+of)\s+(\d+)\b/i) ||
    text.match(/\b(\d+)\s*(?:people|guests?|pax|persons?)\b/i) ||
    text.match(/لـ?\s*(\d+)\s*أشخاص/)
  const party = partyMatch ? parseInt(partyMatch[1], 10) : booking.diningParty ?? null
  const date = parseRelativeDate(text) || parseDate(text) || booking.diningDate || ''
  const time = parseTime(text) || booking.diningTime || ''
  const restaurantMatch = text.match(/\b(al\s*rimal|ergon|asrah|beetza|الرمل|الرمال|إرغون|أسرح|بيتزا)\b/i)
  const restaurant = restaurantMatch
    ? /rimal|رمل/i.test(restaurantMatch[1])
      ? 'Al Rimal'
      : /ergon|إرغون/i.test(restaurantMatch[1])
        ? 'Ergon'
        : /asrah|أسرح/i.test(restaurantMatch[1])
          ? 'Asrah'
          : 'Beetza'
    : ''
  const guestName = parseName(text) || booking.guestName || ''
  const phone = parsePhone(text) || booking.phone || ''
  const notes = [
    restaurant && `Restaurant: ${restaurant}`,
    party && `Party: ${party}`,
    date && `Date: ${date}`,
    time && `Time: ${time}`,
    text.trim(),
  ]
    .filter(Boolean)
    .join(' · ')
  return { party, date, time, restaurant, guestName, phone, notes }
}

function extractRichReservation(text: string): Partial<BookingFields> {
  const updates: Partial<BookingFields> = {}
  const stay = parseStayDates(text)
  if (stay.checkIn) updates.checkIn = stay.checkIn
  if (stay.checkOut) updates.checkOut = stay.checkOut
  if (stay.arrivalTime) {
    updates.specialRequests = `Arrival around ${stay.arrivalTime}`
  }

  const guests = parseGuests(text)
  if (guests.adults !== null) {
    updates.adults = guests.adults
    updates.children = guests.children ?? 0
  } else if (guests.children !== null) {
    updates.children = guests.children
  }

  const layout = parseRoomLayout(text)
  const rooms = text.match(/(\d+)\s*rooms?\b/i) || text.match(/(\d+)\s*غرف/)
  if (rooms) updates.rooms = parseInt(rooms[1], 10)
  else if (layout.rooms != null) updates.rooms = layout.rooms
  if (/غرفة/.test(text) && updates.rooms == null) updates.rooms = 1
  if (updates.rooms == null && impliesSingleRoomBooking(text) && !layout.note) {
    updates.rooms = 1
  }
  if (layout.note) {
    updates.specialRequests = [updates.specialRequests, layout.note].filter(Boolean).join('; ')
  }

  const familyNights = text.match(/\bfor\s+(\d+)\s*nights?\b/i)
  if (familyNights && !updates.checkOut && updates.checkIn) {
    const [y, m, d] = updates.checkIn.split('-').map((x) => parseInt(x, 10))
    updates.checkOut = addDays(new Date(y, m - 1, d, 12), parseInt(familyNights[1], 10))
  } else if (familyNights && !updates.checkIn) {
    updates.specialRequests = [updates.specialRequests, `${familyNights[1]} nights`].filter(Boolean).join('; ')
  }

  // DEMO National Day weekend mapping: inquiry dates only, never “sold out” claims
  if (/\bnational\s*day\b/i.test(text) && !updates.checkIn) {
    const nMatch = text.match(/\b(\d+)\s*nights?\b/i)
    const nights = nMatch ? parseInt(nMatch[1], 10) : 2
    updates.checkIn = DEMO_NATIONAL_DAY_WEEKEND_START
    const [y, m, d] = DEMO_NATIONAL_DAY_WEEKEND_START.split('-').map((x) => parseInt(x, 10))
    updates.checkOut = addDays(new Date(y, m - 1, d, 12), nights)
    updates.specialRequests = [
      updates.specialRequests,
      'Guest mentioned National Day weekend (DEMO date mapping: subject to reservations confirmation)',
    ]
      .filter(Boolean)
      .join('; ')
  }

  const phone = parsePhone(text)
  if (phone) updates.phone = phone

  const nameMatch = text.match(
    /(?:name(?:\s+is)?|i am|i'm|guest|اسمي)\s+([A-Za-z\u0600-\u06FF][A-Za-z\u0600-\u06FF\s]{1,40}?)(?=,|\.|$|phone|الهاتف|\+|هاتف|\d{4}|check|adult)/i,
  )
  if (nameMatch) {
    updates.guestName = parseName(`Name ${nameMatch[1]}`) || titleCaseName(nameMatch[1].trim())
  } else {
    const n = parseName(text) || extractUnlabeledName(text)
    if (n) updates.guestName = n
  }

  if (/late\s*check|after\s*10|وصول متأخر|بعد العاشرة/i.test(text)) {
    const late = /وصول متأخر|بعد العاشرة/.test(text)
      ? 'تسجيل وصول متأخر بعد الساعة 10 مساءً'
      : 'Late check-in after 10pm'
    updates.specialRequests = updates.specialRequests ? `${updates.specialRequests}; ${late}` : late
  }

  return updates
}

function buildConfirmText(b: BookingFields, language: Language): string {
  const cat =
    b.roomCategory
      ? language === 'ar'
        ? `، فئة ${b.roomCategory}`
        : `, preferred category ${b.roomCategory}`
      : ''
  if (language === 'ar') {
    return `ملخص الحجز: ${b.guestName || 'ضيف'}، ${b.adults ?? '-'} بالغين و ${b.children ?? 0} أطفال، ${b.rooms ?? 1} غرفة${cat}، من ${fmtDate(b.checkIn, 'ar')} إلى ${fmtDate(b.checkOut, 'ar')}، هاتف ${b.phone || '-'}، ملاحظات: ${b.specialRequests || 'لا يوجد'}. هل تؤكدون لإشعار مكتب الحجوزات؟`
  }
  return `May I confirm: ${b.guestName || 'Guest'}, ${b.adults ?? '-'} adult${(b.adults ?? 0) === 1 ? '' : 's'} and ${b.children ?? 0} child${(b.children ?? 0) === 1 ? '' : 'ren'}, ${b.rooms ?? 1} room${(b.rooms ?? 1) === 1 ? '' : 's'}${cat}, ${fmtDate(b.checkIn)} to ${fmtDate(b.checkOut)}, phone ${b.phone || '-'}, special requests: ${b.specialRequests || 'none'}. Shall I notify the reservations desk to confirm availability and rate?`
}

function finalizeBooking(booking: BookingFields, language: Language, afterHours: boolean): AgentReply {
  const { subject, body } = buildDeskNotificationBody(booking, afterHours)
  const outcome: Outcome = afterHours ? 'after_hours_saved' : 'booked_inquiry'
  const upsell = formatUpsellMenu(language)
  const party = `${booking.adults ?? '?'} adults / ${booking.children ?? 0} children`
  const stay = `${booking.checkIn || '?'} → ${booking.checkOut || '?'}`
  return {
    text:
      language === 'ar'
        ? `تم إشعار مكتب الحجوزات عبر واتساب. سيتواصلون لتأكيد التوفر والسعر. ${upsell} لإنهاء المكالمة قولوا «مع السلامة» أو «لا شكرا».`
        : `I’ve notified the reservations desk by WhatsApp. They will call you back to confirm availability and rate. ${upsell} When you’re finished, say “no thanks” or “goodbye”.`,
    toolCalls: [
      { tool: 'confirm_booking_summary', args: { confirmed: true }, result: 'Guest confirmed' },
      { tool: 'create_desk_notification', args: { subject, body }, result: 'Desk notified' },
      {
        tool: 'escalate_to_human',
        args: { reason: afterHours ? 'After-hours reservation inquiry' : 'Reservation inquiry' },
        result: 'Staff ticket created',
      },
    ],
    nextStep: 'completed',
    bookingUpdates: {},
    outcome,
    createNotification: { subject, body },
    createTicket: {
      reason: afterHours ? 'After-hours reservation inquiry' : 'Reservation inquiry',
      summary: `${booking.guestName || 'Guest'} · ${party} · ${stay}`,
      priority: 'normal',
    },
    end: true,
  }
}
