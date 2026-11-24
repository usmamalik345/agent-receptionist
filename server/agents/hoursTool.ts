/**
 * get_hours tool: answers opening-hours questions straight from config, never from
 * model recall. Real gpt-oss-20b said "Uppingham Road closes at 5pm on Tuesday"
 * (config: 7pm) even with the right passage in context; the guard blocked it, but the
 * caller then heard a hand-off line instead of the answer. Hours are structured data,
 * so the response agent now calls this tool first and the LLM is skipped for them.
 */
export type DayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'
export interface HoursLocation {
  name: string
  hours: Partial<Record<DayKey, string>>
}

const DAY_ORDER: DayKey[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
const DAY_NAME: Record<DayKey, string> = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' }
const DAY_RE: Record<DayKey, RegExp> = {
  mon: /\bmon(day)?s?\b/i, tue: /\btue(s|sday)?s?\b/i, wed: /\bwed(nesday)?s?\b/i, thu: /\bthu(rs|rsday)?s?\b/i,
  fri: /\bfri(day)?s?\b/i, sat: /\bsat(urday)?s?\b/i, sun: /\bsun(day)?s?\b/i,
}
const HOURS_Q = /\b(open|opening|close|closing|closed|hours?|what time|until|till|late)\b/i
// Questions that mention hours but are really about something else -> leave to retrieval/LLM
const NOT_HOURS = /\b(price|cost|fee|how much|book|appointment for|parking|address|where)\b/i
const GENERIC = /^(the|road|street|practice|clinic|branch|surgery|dental|care|hotel|resort|and)$/i

export interface HoursAnswer {
  text: string
  /** passage-style citation ids, e.g. hours:uppingham-road-practice */
  citations: string[]
  days: DayKey[]
  locations: string[]
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
/** "8:30am–7pm" -> "8:30am to 7pm" so TTS reads it naturally */
const speakable = (h: string) => h.replace(/\s*[–-]\s*/g, ' to ')

export function detectDays(q: string, now: Date = new Date()): DayKey[] {
  const days = DAY_ORDER.filter((d) => DAY_RE[d].test(q))
  if (/\btoday\b/i.test(q)) days.push(DAY_ORDER[(now.getDay() + 6) % 7])
  if (/\btomorrow\b/i.test(q)) days.push(DAY_ORDER[(now.getDay() + 7) % 7])
  return [...new Set(days)]
}

export function isHoursQuestion(q: string): boolean {
  return HOURS_Q.test(q) && !NOT_HOURS.test(q)
}

/** Returns null when the question is not an hours question (caller falls through to retrieval + LLM). */
export function answerHoursQuestion(locations: HoursLocation[], q: string, opts: { now?: Date } = {}): HoursAnswer | null {
  if (!locations.length || !isHoursQuestion(q)) return null
  const named = locations.filter((l) => {
    const key = l.name.split(/\s+/).find((w) => !GENERIC.test(w))
    return key ? new RegExp(`\\b${key}\\b`, 'i').test(q) : false
  })
  const locs = named.length ? named : locations
  const days = detectDays(q, opts.now)
  const parts: string[] = []
  for (const l of locs) {
    const prefix = locations.length > 1 ? `${l.name}: ` : ''
    if (days.length) {
      const segs = days.map((d) => {
        const h = l.hours[d]
        return !h ? `${DAY_NAME[d]} not listed` : /closed/i.test(h) ? `closed on ${DAY_NAME[d]}` : `${DAY_NAME[d]} ${speakable(h)}`
      })
      parts.push(`${prefix}${segs.join(', ')}.`)
    } else {
      // No day named: compress the week into runs of identical hours
      const runs: Array<{ from: DayKey; to: DayKey; h: string }> = []
      for (const d of DAY_ORDER) {
        const h = l.hours[d] ?? 'not listed'
        const last = runs.at(-1)
        if (last && last.h === h) last.to = d
        else runs.push({ from: d, to: d, h })
      }
      const segs = runs.map((r) => `${DAY_NAME[r.from]}${r.from !== r.to ? ` to ${DAY_NAME[r.to]}` : ''} ${/closed/i.test(r.h) ? 'closed' : speakable(r.h)}`)
      parts.push(`${prefix}${segs.join(', ')}.`)
    }
  }
  return { text: parts.join(' '), citations: locs.map((l) => `hours:${slug(l.name)}`), days, locations: locs.map((l) => l.name) }
}
