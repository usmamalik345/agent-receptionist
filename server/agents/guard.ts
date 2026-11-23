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

export interface GuardInput {
  text: string
  source: 'llm' | 'engine'
  /** Text the reply may draw facts from */
  grounding: string[]
  /** Phones / emails that may be spoken (business lines, caller's own) */
  allowedContacts?: string[]
  maxChars?: number
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

export function guardReply(input: GuardInput): GuardResult {
  const ground = input.grounding.join('\n')
  const prices = new Set((ground.match(PRICE) ?? []).map(normMoney))
  const times = new Set((ground.match(TIME) ?? []).map(normTime))
  const contacts = new Set([...(input.allowedContacts ?? []), ...(ground.match(PHONE) ?? [])].map(digits).filter(Boolean))
  const emails = new Set([...(input.allowedContacts ?? []), ...(ground.match(EMAIL) ?? [])].map((e) => e.toLowerCase()))
  const v: GuardViolation[] = []
  for (const p of input.text.match(PRICE) ?? []) if (!prices.has(normMoney(p))) v.push({ kind: 'ungrounded_price', value: p })
  for (const t of input.text.match(TIME) ?? []) if (!times.has(normTime(t))) v.push({ kind: 'ungrounded_time', value: t })
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
