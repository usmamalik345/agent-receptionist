/**
 * Failure taxonomy, derived automatically from trace fields (and replay expectation
 * failures). Every category prefix must map to >=1 replay test in evals/taxonomy.json;
 * tests/replay-taxonomy.test.ts enforces that mapping and runs those tests.
 */
import { HUMAN_CONFIDENCE_THRESHOLD } from '../server/router.ts'
import type { TurnTrace } from '../server/tracing.ts'

/** Category prefixes the categorizer can emit (`prefix` or `prefix:<detail>`). */
export const CATEGORY_PREFIXES = [
  'error', 'timeout', 'tool_error', 'tool_misuse', 'fallback', 'handoff', 'low_confidence', 'failed_clarification',
  'unknown_intent_fallback_reply', 'empty_answer', 'over_latency_budget', 'filler_first', 'ungrounded_answer',
  'pii_leak', 'guard_blocked', 'long_reply', 'token_cap', 'wrong_route', 'missed_handoff', 'expectation_failed',
] as const
export type CategoryPrefix = (typeof CATEGORY_PREFIXES)[number]

const isTimeout = (s?: string | null) => /timeout|timed out|abort/i.test(s ?? '')

export function categorize(t: TurnTrace, budgetMs: number): string[] {
  const cats: string[] = []
  const bad = (t.spans ?? []).filter((s) => !s.ok)
  for (const s of bad) cats.push(`${isTimeout(s.error) ? 'timeout' : 'error'}:${s.name}`)
  if (t.error && bad.length === 0) cats.push(isTimeout(t.error) ? 'timeout:turn' : 'error:turn')
  for (const tc of t.tool_calls ?? []) {
    if (String(tc.result ?? '').startsWith('schema_error')) cats.push(`tool_misuse:${tc.tool}`)
    else if (!tc.ok) cats.push(`tool_error:${tc.tool}`)
  }
  if (t.fallback) cats.push(`fallback:${t.fallback.reason}`)
  if (t.route === 'human' || t.handoff) cats.push(`handoff:${t.router?.reason ?? t.outcome ?? 'unknown'}`)
  if (t.router && t.router.confidence < HUMAN_CONFIDENCE_THRESHOLD) cats.push('low_confidence')
  if (t.failed_clarification) cats.push('failed_clarification')
  if (t.intent === 'unknown') cats.push('unknown_intent_fallback_reply')
  if (t.reply_chars === 0) cats.push('empty_answer')
  const fa = typeof t.ttfa_ms === 'number' ? t.ttfa_ms : t.first_audio_ready_ms
  if (typeof fa === 'number' && fa > budgetMs) cats.push('over_latency_budget')
  if (t.first_audio_kind === 'filler') cats.push('filler_first')
  for (const v of t.guard?.violations ?? []) {
    if (v.kind.startsWith('ungrounded')) cats.push(`ungrounded_answer:${v.kind.replace('ungrounded_', '')}`)
    else if (v.kind.startsWith('pii')) cats.push(`pii_leak:${v.kind.replace('pii_', '')}`)
    else if (v.kind === 'length') cats.push(`long_reply:${t.agent_path ?? 'engine'}`)
  }
  if (t.guard?.blocked) cats.push('guard_blocked')
  if (t.token_cap_hit) cats.push('token_cap')
  return [...new Set(cats)]
}

/** Replay expectation errors (scripts/expect.mts wording) -> categories. */
export function categorizeExpectationError(err: string): string {
  if (/\broute (\w+) != (\w+)/.test(err)) {
    const m = err.match(/route (\w+) != (\w+)/)!
    return m[2] === 'human' ? 'missed_handoff' : `wrong_route:${m[2]}`
  }
  if (/handoff false != true/.test(err)) return 'missed_handoff'
  if (/no citation|guard ok/.test(err)) return 'ungrounded_answer:expectation'
  return 'expectation_failed'
}

export const prefixOf = (cat: string): string => cat.split(':')[0]
