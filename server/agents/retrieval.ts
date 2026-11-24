/**
 * Retrieval agent: BM25 over the business's OWN config (services, pricing, hours,
 * locations, FAQs, emergency policy). Returns ranked passages with source ids
 * (citations), never prose. Pure TS, no embeddings service, no network.
 */
import type { BusinessConfig, DayKey } from '../../src/config/businessTypes.ts'

export interface Passage {
  id: string
  text: string
  /** which config field the passage came from */
  source: 'faq' | 'pricing' | 'service' | 'hours' | 'location' | 'emergency' | 'about' | 'after_hours'
  /** Extra index-only terms (e.g. words from the FAQ's keyword regex); never spoken */
  terms?: string
}
export interface ScoredPassage extends Passage {
  score: number
}

const DAY_NAMES: Record<DayKey, string> = {
  mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday',
}
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

/** Index-only synonyms so plain caller wording reaches the hours / address passages. */
const HOURS_TERMS = 'open opening close closing closed hours time times day days today weekday weekend late early'
const LOCATION_TERMS = 'address where based located location find directions practice phone number call ring'

export function buildPassages(biz: BusinessConfig): Passage[] {
  const out: Passage[] = []
  biz.faqs.forEach((f, i) =>
    out.push({ id: `faq:${i}`, source: 'faq', text: `Q: ${f.q} A: ${f.a}`, terms: f.keywords ? regexTerms(f.keywords) : undefined }),
  )
  biz.pricing.forEach((p, i) => out.push({ id: `price:${i}`, source: 'pricing', text: `${p.item}: ${p.price}.` }))
  biz.services.forEach((s, i) =>
    out.push({
      id: `service:${i}`,
      source: 'service',
      text: !s.priceNote ? `${s.name} is offered.` : /^available$/i.test(s.priceNote) ? `${s.name} is available.` : `${s.name}: ${s.priceNote}.`,
    }),
  )
  for (const loc of biz.locations) {
    const days = (Object.keys(DAY_NAMES) as DayKey[]).map((d) => `${DAY_NAMES[d]} ${loc.hours[d]}`).join(', ')
    // Location notes are facts about hours (e.g. "Saturday patients are seen at Uppingham Road"):
    // without them a model reads "Saturday 9am–12pm phone lines only" as open for appointments.
    const note = loc.notes ? ` Note: ${loc.notes}` : ''
    out.push({ id: `hours:${slug(loc.name)}`, source: 'hours', text: `${loc.name} opening hours: ${days}.${note}`, terms: HOURS_TERMS })
    out.push({ id: `location:${slug(loc.name)}`, source: 'location', text: `${loc.name} address: ${loc.address}. Phone ${loc.phone}.`, terms: LOCATION_TERMS })
  }
  if (biz.emergency?.enabled) {
    out.push({ id: 'emergency', source: 'emergency', text: `${biz.emergency.message} ${biz.emergency.severeAdvice ?? ''}`.trim() })
  }
  if (biz.about) out.push({ id: 'about', source: 'about', text: biz.about })
  if (biz.afterHoursMessage) out.push({ id: 'after-hours', source: 'after_hours', text: biz.afterHoursMessage })
  return out
}

/** Literal words inside a keyword regex source, e.g. /pay(ment| as you go)|monthly/ -> "pay ment as you go monthly". */
export function regexTerms(re: RegExp): string {
  return re.source.replace(/\\[a-z]\*?|\\b|[?*+]/gi, ' ').replace(/[^a-z\s]/gi, ' ').replace(/\s+/g, ' ').trim()
}

const STOP = new Set(
  'a an the and or of to in on at for is are am be do does did you your we our i me my it this that what when where which who how can could would will with from have has any there please hi hello'.split(' '),
)

export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[–—]/g, ' ')
    .replace(/[^a-z0-9£.\s]/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^\.+|\.+$/g, ''))
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map(stem)
}

/** Tiny suffix stemmer so "patients"~"patient", "opening"~"open". */
function stem(w: string): string {
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y'
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3)
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1)
  return w
}

export class Bm25Index {
  private readonly docs: Array<{ p: Passage; tf: Map<string, number>; len: number }>
  private readonly df = new Map<string, number>()
  private readonly avgLen: number
  private readonly k1: number
  private readonly b: number
  constructor(passages: Passage[], k1 = 1.2, b = 0.75) {
    this.k1 = k1
    this.b = b
    this.docs = passages.map((p) => {
      const toks = tokenize(p.terms ? `${p.text} ${p.terms}` : p.text)
      const tf = new Map<string, number>()
      for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1)
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1)
      return { p, tf, len: toks.length }
    })
    this.avgLen = this.docs.reduce((s, d) => s + d.len, 0) / Math.max(1, this.docs.length)
  }
  search(query: string, k = 3): ScoredPassage[] {
    const q = [...new Set(tokenize(query))]
    const N = this.docs.length
    const scored = this.docs.map(({ p, tf, len }) => {
      let score = 0
      for (const t of q) {
        const f = tf.get(t)
        if (!f) continue
        const df = this.df.get(t) ?? 0
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5))
        score += idf * ((f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * len) / this.avgLen)))
      }
      return { ...p, score: Math.round(score * 1000) / 1000 }
    })
    return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, k)
  }
}

export interface RetrievalResult {
  passages: ScoredPassage[]
  /** true when the best passage clears minScore */
  grounded: boolean
  ms: number
}

const indexCache = new WeakMap<BusinessConfig, Bm25Index>()

export function retrieve(biz: BusinessConfig, query: string, opts: { k?: number; minScore?: number } = {}): RetrievalResult {
  const t0 = performance.now()
  let idx = indexCache.get(biz)
  if (!idx) {
    idx = new Bm25Index(buildPassages(biz))
    indexCache.set(biz, idx)
  }
  const passages = idx.search(query, opts.k ?? 3)
  const minScore = opts.minScore ?? 1.0
  return { passages, grounded: (passages[0]?.score ?? 0) >= minScore, ms: Math.round((performance.now() - t0) * 1000) / 1000 }
}
