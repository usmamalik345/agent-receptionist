/**
 * Triage agent = intent (router.triage: rules + corpus match) + risk.
 * Risk is a deterministic keyword classifier (no model): it is what the PDF calls
 * the "small, fast" triage stage. High-risk turns stay on the rule path, which
 * gives the configured safety line (999 / A&E) and raises an URGENT ticket for staff.
 */
import type { Intent } from '../../src/lib/types.ts'

export type Risk = 'low' | 'medium' | 'high'

const HIGH = /\b(can'?t\s*breathe|breathing|swallow|severe\s*swelling|unconscious|chest\s*pain|bleeding\s*(heavily|a lot|won'?t stop)|knocked\s*out)\b/i
const MEDIUM_INTENTS = new Set<Intent>(['emergency', 'complaint'])
const MEDIUM = /\b(complain|complaint|solicitor|lawyer|refund|angry|unacceptable)\b/i

export function assessRisk(text: string, intent: Intent): Risk {
  if (HIGH.test(text)) return 'high'
  if (MEDIUM_INTENTS.has(intent) || MEDIUM.test(text)) return 'medium'
  return 'low'
}
