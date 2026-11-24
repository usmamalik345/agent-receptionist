/**
 * Deterministic slot extraction for the booking agent (dates, times, guests, nights,
 * names, phones, treatments, room types). Regex-based on purpose: booking writes must
 * not depend on a model's guess. Anything not understood is simply not filled and the
 * agent asks again.
 */
import { isFillerUtterance } from '../../src/lib/fillers.ts'

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const NUM_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, a: 1, an: 1, single: 1, couple: 2 }

export const isoDate = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
export const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return isoDate(d)
}
export const weekdayOf = (iso: string) => new Date(`${iso}T12:00:00Z`).getUTCDay()
export const nightsBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000)
export function spokenDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`)
  const day = d.getUTCDate()
  const sfx = day % 10 === 1 && day !== 11 ? 'st' : day % 10 === 2 && day !== 12 ? 'nd' : day % 10 === 3 && day !== 13 ? 'rd' : 'th'
  const month = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][d.getUTCMonth()]
  return `${WEEKDAYS[d.getUTCDay()][0].toUpperCase()}${WEEKDAYS[d.getUTCDay()].slice(1)} the ${day}${sfx} of ${month}`
}

/** All dates mentioned, in order. `today` is the tenant's local date (ISO). */
export function parseDates(text: string, today: string): string[] {
  const t = text.toLowerCase()
  const found: Array<{ at: number; iso: string }> = []
  const year = Number(today.slice(0, 4))
  const push = (at: number, m: number, d: number) => {
    if (m < 0 || m > 11 || d < 1 || d > 31) return
    let iso = `${year}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    if (iso < today) iso = `${year + 1}${iso.slice(4)}`
    found.push({ at, iso })
  }
  for (const m of t.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) found.push({ at: m.index!, iso: m[0] })
  for (const m of t.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/g)) push(m.index!, MONTHS.indexOf(m[2]), Number(m[1]))
  for (const m of t.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?\b/g)) push(m.index!, MONTHS.indexOf(m[1]), Number(m[2]))
  for (const m of t.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?\b/g)) push(m.index!, Number(m[2]) - 1, Number(m[1]))
  for (const m of t.matchAll(/\btoday\b/g)) found.push({ at: m.index!, iso: today })
  for (const m of t.matchAll(/\btomorrow\b/g)) found.push({ at: m.index!, iso: addDays(today, 1) })
  for (const m of t.matchAll(/\b(next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/g)) {
    const target = WEEKDAYS.indexOf(m[2])
    let diff = (target - weekdayOf(today) + 7) % 7
    if (diff === 0) diff = 7
    if (m[1] && diff < 7) diff += 0
    found.push({ at: m.index!, iso: addDays(today, diff) })
  }
  return [...new Set(found.sort((a, b) => a.at - b.at).map((f) => f.iso))]
}

/** "10am", "3:30pm", "15:00", "half ten" not supported. Returns HH:MM 24h. */
export function parseTime(text: string): string | null {
  const t = text.toLowerCase()
  let m = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/)
  if (m) {
    let h = Number(m[1]) % 12
    if (m[3] === 'pm') h += 12
    return `${String(h).padStart(2, '0')}:${m[2] ?? '00'}`
  }
  m = t.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/)
  if (m) return `${m[1].padStart(2, '0')}:${m[2]}`
  return null
}
export function parsePartOfDay(text: string): 'morning' | 'afternoon' | 'evening' | null {
  const m = text.toLowerCase().match(/\b(morning|afternoon|evening|after work|lunchtime)\b/)
  if (!m) return null
  return m[1] === 'after work' ? 'evening' : m[1] === 'lunchtime' ? 'afternoon' : (m[1] as 'morning' | 'afternoon' | 'evening')
}
export function spokenTime(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number)
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}${m ? `:${String(m).padStart(2, '0')}` : ''}${h < 12 ? 'am' : 'pm'}`
}

const num = (w: string) => (/^\d+$/.test(w) ? Number(w) : NUM_WORDS[w] ?? null)
export function parseGuests(text: string): number | null {
  const t = text.toLowerCase()
  let total = 0
  let any = false
  for (const m of t.matchAll(/\b(\d+|one|two|three|four|five|six|a|an)\s+(adults?|people|persons?|guests?|kids?|children|child)\b/g)) {
    const n = num(m[1])
    if (n !== null) { total += n; any = true }
  }
  if (any) return total
  const us = t.match(/\b(just me|myself|on my own)\b/) ? 1 : t.match(/\b(two of us|me and my (wife|husband|partner)|a couple)\b/) ? 2 : null
  if (us) return us
  const forN = t.match(/\bfor\s+(\d+|one|two|three|four|five|six)\b(?!\s*(nights?|days?|am|pm|:))/)
  return forN ? num(forN[1]) : null
}
export function parseNights(text: string): number | null {
  const m = text.toLowerCase().match(/\b(\d+|one|two|three|four|five|six|seven|a)\s+nights?\b/)
  return m ? num(m[1]) : null
}
export function parsePhone(text: string): string | null {
  const m = text.match(/(\+?\d[\d\s()-]{8,}\d)/)
  if (!m) return null
  const d = m[1].replace(/\D/g, '')
  return d.length >= 10 && d.length <= 13 ? m[1].trim() : null
}

const NOT_NAME = /\b(book|appointment|room|tomorrow|today|morning|afternoon|evening|yes|no|please|check|night|nights|adults?|guests?|people|am|pm|monday|tuesday|wednesday|thursday|friday|saturday|sunday|want|need|like|would|could|price|cost|filling|whitening|polish|suite|twin|double|family|standard)\b/i
export function parseName(text: string, expectingName: boolean): string | null {
  const explicit = text.match(/\b(?:my name is|name is|this is|i am|i'm|it's|its)\s+([a-z][a-z'-]+(?:\s+[a-z][a-z'-]+){0,2})\b/i)
  let cand = explicit?.[1] ?? null
  if (!cand && expectingName) {
    const bare = text.replace(/[.,!?]/g, '').trim()
    if (/^[a-z][a-z'-]+(?:\s+[a-z][a-z'-]+){0,2}$/i.test(bare)) cand = bare
  }
  if (!cand) return null
  cand = cand.replace(/\s+(and|my|phone|number)\b.*$/i, '').trim()
  if (isFillerUtterance(cand) || NOT_NAME.test(cand) || cand.length < 2) return null
  return cand.split(/\s+/).map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ')
}

export const isYes = (t: string) => /^(yes|yeah|yep|yup|sure|correct|that's right|that is right|please do|go ahead|book it|confirm|perfect|ok|okay|great)\b/i.test(t.trim()) && !/\b(no|not|don't|wait)\b/i.test(t)
export const isNo = (t: string) => /^(no|nope|not|wait|actually|change|cancel|don't)\b/i.test(t.trim())

/** Best match of free text against a list of names (treatments / room types), with synonyms. */
export function matchOption(text: string, options: string[], synonyms: Record<string, string[]> = {}): string | null {
  const t = text.toLowerCase()
  for (const o of options) {
    const words = [o.toLowerCase(), ...(synonyms[o.toLowerCase()] ?? [])]
    if (words.some((w) => t.includes(w))) return o
  }
  return null
}
export const TREATMENT_SYNONYMS: Record<string, string[]> = {
  'check-up': ['check up', 'checkup', 'examination', 'exam', 'routine'],
  'scale and polish': ['clean', 'cleaning', 'hygien', 'scale'],
  filling: ['cavity', 'fillings'],
  'teeth whitening': ['whiten'],
  'emergency appointment': ['emergency', 'toothache', 'in pain', 'broken tooth'],
  'root canal': ['root'],
}
export const ROOM_SYNONYMS: Record<string, string[]> = {
  'standard double': ['double', 'standard', 'king', 'queen'],
  twin: ['twin', 'two beds', 'separate beds'],
  'family room': ['family'],
  suite: ['suite'],
}
