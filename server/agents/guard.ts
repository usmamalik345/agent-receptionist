/**
 * Guard before TTS. Checks every reply:
 *  - prices (£/$/AED amounts) and clock times must appear in the grounding text
 *    (cited passages for model output; business config + caller's own words for engine output)
 *  - no PII leak: phone numbers / emails must be the business's own or the caller's own
 *  - length cap for model output (engine copy is pre-written safety text: warn only)
 * Model output that fails a grounding/PII check is blocked; the caller gets the
 * deterministic engine reply (or a safe "team will confirm" line) instead.
 */

export type GuardViolation =
  | { kind: 'ungrounded_price'; value: string }
  | { kind: 'ungrounded_time'; value: string }
  | { kind: 'pii_phone'; value: string }
  | { kind: 'pii_email'; value: string }
  | { kind: 'length'; value: string }
  | { kind: 'hours_mismatch'; value: string }

export interface GuardInput {
  text: string
  source: 'llm' | 'engine'
  /** Text the reply may draw facts from */
  grounding: string[]
  /** Phones / emails that may be spoken (business lines, caller's own) */
  allowedContacts?: string[]
  maxChars?: number
  /** Opening hours per location: a sentence naming ONE location and a day may only use that day's times */
  hours?: Array<{ name: string; hours: Partial<Record<Day, string>> }>
  /** The caller's own words: a time the caller said (e.g. "8pm?") may be repeated back. Prices never. */
  callerText?: string
}

export interface GuardResult {
  ok: boolean
  /** Text after fixes (length cap / redaction); only meaningful when ok or source=engine */
  text: string
  violations: GuardViolation[]
  blocked: boolean
}

export const SAFE_LINE = "I don't want to give you the wrong information, so I'll ask the team to confirm that for you."

const PRICE = /(?:£|\$|AED\s?)\s?\d+(?:[.,]\d{1,2})?/gi
const TIME = /\b\d{1,2}(?::\d{2})?\s?(?:am|pm)\b/gi
const PHONE = /(?:\+?\d[\d\s-]{8,}\d)/g
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+/g

const normMoney = (s: string) => s.replace(/\s+/g, '').replace(',', '.').toLowerCase().replace(/\.00$/, '')
const normTime = (s: string) => s.replace(/\s+/g, '').toLowerCase().replace(/:00(?=am|pm)/, '')
const digits = (s: string) => s.replace(/\D/g, '')

function capSentences(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '))
  return end > 40 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, '') + '.'
}

type Day = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'
const DAYS: Array<[Day, RegExp]> = [
  ['mon', /\bmondays?\b/i], ['tue', /\btuesdays?\b/i], ['wed', /\bwednesdays?\b/i], ['thu', /\bthursdays?\b/i],
  ['fri', /\bfridays?\b/i], ['sat', /\bsaturdays?\b/i], ['sun', /\bsundays?\b/i],
]
const GENERIC_NAME = /^(the|road|street|practice|clinic|branch|surgery|dental|care)$/i

/**
 * Day/time consistency: "Uppingham Road closes at 5pm on Tuesday" passes the plain
 * time check (5pm is in the passage, for Monday) but is wrong. Per sentence: if it
 * names exactly one location (or the business has one) and at least one day, every
 * clock time must belong to that location's hours on those days.
 */
function hoursMismatches(text: string, input: GuardInput, callerTimes: Set<string>): string[] {
  const locs = input.hours ?? []
  if (!locs.length) return []
  const out: string[] = []
  for (const sentence of text.split(/(?<=[.!?;])\s+/)) {
    const times = (sentence.match(TIME) ?? []).map(normTime)
    if (!times.length) continue
    const days = DAYS.filter(([, re]) => re.test(sentence)).map(([d]) => d)
    if (!days.length) continue
    const named = locs.filter((l) => {
      const key = l.name.split(/\s+/).find((w) => !GENERIC_NAME.test(w))
      return key ? new RegExp(`\\b${key}\\b`, 'i').test(sentence) : false
    })
    const loc = named.length === 1 ? named[0] : locs.length === 1 ? locs[0] : null
    if (!loc) continue
    const allowed = new Set(days.flatMap((d) => (loc.hours[d] ?? '').match(TIME) ?? []).map(normTime))
    for (const t of times) if (!allowed.has(t) && !callerTimes.has(t)) out.push(`${loc.name} ${days.join('/')} ${t}`)
  }
  return out
}

export function guardReply(input: GuardInput): GuardResult {
  const ground = input.grounding.join('\n')
  const prices = new Set((ground.match(PRICE) ?? []).map(normMoney))
  const times = new Set((ground.match(TIME) ?? []).map(normTime))
  const contacts = new Set([...(input.allowedContacts ?? []), ...(ground.match(PHONE) ?? [])].map(digits).filter(Boolean))
  const emails = new Set([...(input.allowedContacts ?? []), ...(ground.match(EMAIL) ?? [])].map((e) => e.toLowerCase()))
  const v: GuardViolation[] = []
  for (const p of input.text.match(PRICE) ?? []) if (!prices.has(normMoney(p))) v.push({ kind: 'ungrounded_price', value: p })
  const callerTimes = new Set((input.callerText?.match(TIME) ?? []).map(normTime))
  for (const t of input.text.match(TIME) ?? []) if (!times.has(normTime(t)) && !callerTimes.has(normTime(t))) v.push({ kind: 'ungrounded_time', value: t })
  for (const m of hoursMismatches(input.text, input, callerTimes)) v.push({ kind: 'hours_mismatch', value: m })
  for (const p of input.text.match(PHONE) ?? []) if (!contacts.has(digits(p))) v.push({ kind: 'pii_phone', value: p.replace(/\d(?=\d{2})/g, '#') })
  for (const e of input.text.match(EMAIL) ?? []) if (!emails.has(e.toLowerCase())) v.push({ kind: 'pii_email', value: e.replace(/^[^@]+/, '***') })

  const max = input.maxChars ?? 320
  let text = input.text
  if (text.length > max) {
    v.push({ kind: 'length', value: String(text.length) })
    if (input.source === 'llm') text = capSentences(text, max)
  }
  const hard = v.filter((x) => x.kind !== 'length')
  const blocked = input.source === 'llm' && hard.length > 0
  return { ok: hard.length === 0, text: blocked ? SAFE_LINE : text, violations: v, blocked }
}
