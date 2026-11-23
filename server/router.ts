/**
 * Turn router - picks exactly one route per final user transcript:
 *   rule      deterministic path for known intents (hours, fees, emergency, goodbye...)
 *   tool      tool / slot-filling path (booking request, reschedule, ticket)
 *   retrieval answer from the business FAQ / knowledge corpus
 *   human     hand-off (explicit ask, confidence < 0.55, or 2 failed clarifications)
 * Pure module (no Node APIs) so the browser demo and the Express server share it.
 * Confidence values are fixed heuristics per triage path - not a trained model.
 */
import type { BusinessConfig } from '../src/config/businessTypes.ts'
import { KNOWLEDGE } from '../src/config/knowledge.ts'
import { detectDentalIntent } from '../src/lib/dentalEngine.ts'
import { detectIntent } from '../src/lib/stateMachine.ts'
import type { ConversationStep, Intent } from '../src/lib/types.ts'

export type Route = 'rule' | 'tool' | 'retrieval' | 'human'
export type FallbackReason = 'budget_exceeded' | 'token_cap' | 'llm_timeout' | 'llm_error'

export const HUMAN_CONFIDENCE_THRESHOLD = 0.55
export const MAX_FAILED_CLARIFICATIONS = 2

/** Heuristic confidences per triage path (documented in README). */
export const CONFIDENCE = {
  explicitHuman: 0.99,
  rule: 0.95,
  tool: 0.9,
  slotFill: 0.85,
  retrievalHit: 0.8,
  retrievalMiss: 0.4,
  empty: 0.6,
} as const

export interface CorpusDoc {
  id: string
  q?: string
  keywords?: RegExp
}

export interface RouterContext {
  callId: string
  turnId: number
  step: ConversationStep | string
  industry: string
  corpus?: CorpusDoc[]
  /** Consecutive failed clarifications so far in this call */
  failedClarifications?: number
  humanConfidenceThreshold?: number
}

export interface RouterDecision {
  type: 'router_decision'
  ts: string
  call_id: string
  turn_id: number
  route: Route
  reason: string
  confidence: number
  matched_rule: string | null
  intent: Intent
  latency_ms: number
  /** Set when the latency/token ladder overrode the normal path */
  fallback_reason?: FallbackReason
}

const RULE_INTENTS = new Set<Intent>(['emergency', 'hours', 'location', 'membership', 'nervous', 'nhs', 'rates', 'goodbye', 'confirm', 'deny'])
const TOOL_INTENTS = new Set<Intent>(['new_patient', 'existing_patient', 'modify', 'reservation', 'dining', 'spa', 'complaint'])
const SLOT_FILL_INTENTS = new Set<Intent>(['confirm', 'deny', 'faq', 'unknown'])
const SLOT_STEPS = new Set<string>([
  'collect_check_in', 'collect_check_out', 'collect_rooms', 'collect_room_type', 'collect_guests',
  'collect_name', 'collect_phone', 'collect_special', 'collect_patient_type', 'collect_practice',
  'collect_reason', 'collect_preferred_time', 'confirm_summary', 'modify_collect', 'dining_details',
  'complaint_details',
])

/** Retrieval corpus = business FAQs (+ hotel knowledge base for hotel industry). */
export function buildRetrievalCorpus(biz: Pick<BusinessConfig, 'faqs' | 'industry'>): CorpusDoc[] {
  const docs: CorpusDoc[] = biz.faqs.map((f, i) => ({ id: `faq:${i}:${f.q}`, q: f.q, keywords: f.keywords }))
  if (biz.industry === 'hotel') {
    for (const [key, entry] of Object.entries(KNOWLEDGE)) {
      const kw = (entry as { keywords?: RegExp }).keywords
      if (kw) docs.push({ id: `kb:${key}`, keywords: kw })
    }
  }
  return docs
}

/** Same matching rule the dental engine uses: keyword regex, or >=2 question words. */
export function matchCorpus(corpus: CorpusDoc[], text: string): CorpusDoc | null {
  const t = text.toLowerCase()
  for (const doc of corpus) {
    if (doc.keywords?.test(text)) return doc
    if (!doc.q) continue
    const words = doc.q.toLowerCase().replace(/[?.,]/g, '').split(/\s+/).filter((w) => w.length > 3)
    if (words.length && words.filter((w) => t.includes(w)).length >= Math.min(2, words.length)) return doc
  }
  return null
}

export interface Triage {
  intent: Intent
  route: Route
  confidence: number
  reason: string
  matched_rule: string | null
}

const tri = (intent: Intent, route: Route, confidence: number, reason: string, matched_rule: string | null): Triage => ({
  intent, route, confidence, reason, matched_rule,
})

/** Triage agent: rules first, then corpus lookup, then low-confidence fallback. */
export function triage(text: string, ctx: RouterContext): Triage {
  const clean = text.trim()
  if (!clean) return tri('unknown', 'rule', CONFIDENCE.empty, 'empty_transcript', 'reprompt')
  const intent: Intent = ctx.industry === 'dental' ? detectDentalIntent(clean) : detectIntent(clean)
  if (intent === 'human') return tri(intent, 'human', CONFIDENCE.explicitHuman, 'caller_asked_for_human', 'intent:human')
  // Generic reply while collecting booking fields -> slot-filling tool (update_booking_fields)
  if (SLOT_STEPS.has(String(ctx.step)) && SLOT_FILL_INTENTS.has(intent)) {
    return tri(intent, 'tool', CONFIDENCE.slotFill, 'slot_filling', `step:${ctx.step}`)
  }
  if (RULE_INTENTS.has(intent)) return tri(intent, 'rule', CONFIDENCE.rule, 'known_intent', `intent:${intent}`)
  if (TOOL_INTENTS.has(intent)) return tri(intent, 'tool', CONFIDENCE.tool, 'tool_intent', `intent:${intent}`)
  const doc = matchCorpus(ctx.corpus ?? [], clean)
  if (doc) return tri(intent, 'retrieval', CONFIDENCE.retrievalHit, 'corpus_match', doc.id)
  return tri(intent, 'retrieval', CONFIDENCE.retrievalMiss, 'no_corpus_match', null)
}

const nowMs = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now()

export function routeTurn(text: string, ctx: RouterContext, clock: () => number = nowMs): RouterDecision {
  const t0 = clock()
  const t = triage(text, ctx)
  const threshold = ctx.humanConfidenceThreshold ?? HUMAN_CONFIDENCE_THRESHOLD
  let { route, reason } = t
  if ((ctx.failedClarifications ?? 0) >= MAX_FAILED_CLARIFICATIONS && route !== 'human') {
    route = 'human'
    reason = 'repeated_clarification_failure'
  } else if (t.confidence < threshold && route !== 'human') {
    route = 'human'
    reason = `low_confidence:${t.reason}`
  }
  return {
    type: 'router_decision',
    ts: new Date().toISOString(),
    call_id: ctx.callId,
    turn_id: ctx.turnId,
    route,
    reason,
    confidence: t.confidence,
    matched_rule: t.matched_rule,
    intent: t.intent,
    latency_ms: Math.round((clock() - t0) * 1000) / 1000,
  }
}

/**
 * A clarification failed when the agent stayed on the same collect step and captured
 * nothing new (no field changed vs. the booking before the turn), or answered with the
 * generic "what do you need?" fallback.
 */
export function isFailedClarification(
  prevStep: string,
  reply: { nextStep: string; bookingUpdates?: object; intent?: string },
  bookingBefore: object = {},
): boolean {
  if (reply.intent === 'unknown') return true
  if (!SLOT_STEPS.has(prevStep) || reply.nextStep !== prevStep) return false
  const before = bookingBefore as Record<string, unknown>
  const changed = Object.entries((reply.bookingUpdates ?? {}) as Record<string, unknown>).filter(
    ([k, v]) => k !== 'language' && v !== '' && v !== null && v !== undefined && v !== before[k],
  )
  return changed.length === 0
}

/** Per-call consecutive failed-clarification counter. */
export class ClarificationTracker {
  private counts = new Map<string, number>()
  get(callId: string): number {
    return this.counts.get(callId) ?? 0
  }
  record(callId: string, failed: boolean): number {
    const next = failed ? this.get(callId) + 1 : 0
    this.counts.set(callId, next)
    return next
  }
  reset(callId: string): void {
    this.counts.delete(callId)
  }
}

export const HANDOFF_TEXT =
  "I'll pass you to a member of the team so you get the right answer. They'll be with you shortly, or call you back as soon as they can."
