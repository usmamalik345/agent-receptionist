/**
 * Triage agent: classifies the caller's turn into an intent and picks the specialist.
 * Rules only (no model): fast, free and auditable; the confidence values are fixed
 * per rule, not learned. Calls no tools.
 */
import { isHoursQuestion } from '../../agents/hoursTool.ts'
import { isNo, isYes } from '../extract.ts'
import type { AgentName, Intent } from '../protocol.ts'
import type { Vertical } from '../tenant.ts'

export interface TriageInput {
  text: string
  vertical: Vertical
  bookingActive: boolean
  confirmationPending: boolean
}
export interface TriageResult {
  intent: Intent
  to: AgentName
  confidence: number
  rule: string
  /** dental: breathing/swallowing affected -> always the 999 / A&E line */
  severe?: boolean
}

const HUMAN = /\b(speak|talk)\s+(to|with)\s+(a\s+)?(human|person|someone|receptionist|manager|staff|real)\b|\b(human|real person|operator)\b|\bagent please\b/i
const GOODBYE = /^(bye|goodbye|thanks?,? bye|that'?s all|no,? that'?s (it|all)|thank you,? bye)\b/i
const GREETING = /^(hi|hello|hey|good (morning|afternoon|evening))[\s!.,]*$/i
const BOOK_DENTAL = /\b(book|booking|appointment|make an appointment|see (a|the) dentist|check[- ]?up|availability|available|slot|come in|reschedule)\b/i
const BOOK_HOTEL = /\b(book|booking|reserve|reservation|room for|a room|stay|availability|available|nights?)\b/i
const PRICE = /\b(price|prices|cost|costs|how much|rate|rates|fee|fees|charge|tariff)\b/i
const POLICY = /\b(check[- ]?in|check[- ]?out|cancel|cancellation|refund|policy)\b/i
const EMERGENCY = /\b(emergency|severe pain|in (a lot of )?pain|toothache|swollen|swelling|bleeding|broken tooth|knocked out|abscess)\b/i
const SEVERE = /\b(can'?t|cannot|struggling to|hard to|difficult to)\s+(breathe|breath|swallow)\b|\bswelling\b.{0,40}\b(eye|neck|throat|breath)/i

export function triage(i: TriageInput): TriageResult {
  const t = i.text.trim()
  if (i.confirmationPending && isYes(t)) return { intent: 'confirm_yes', to: 'booking', confidence: 0.95, rule: 'confirm_yes' }
  if (i.confirmationPending && isNo(t)) return { intent: 'confirm_no', to: 'booking', confidence: 0.95, rule: 'confirm_no' }
  if (HUMAN.test(t)) return { intent: 'human', to: 'human', confidence: 0.95, rule: 'human_request' }
  if (i.vertical === 'dental' && SEVERE.test(t)) return { intent: 'emergency', to: 'faq', confidence: 0.95, rule: 'severe_symptoms', severe: true }
  if (i.vertical === 'dental' && EMERGENCY.test(t) && !i.bookingActive) return { intent: 'emergency', to: 'faq', confidence: 0.9, rule: 'emergency' }
  if (GOODBYE.test(t)) return { intent: 'goodbye', to: 'faq', confidence: 0.9, rule: 'goodbye' }
  if (GREETING.test(t)) return { intent: 'greeting', to: 'faq', confidence: 0.9, rule: 'greeting' }
  if (i.vertical === 'hotel' && /\b(check[- ]?in|check[- ]?out)\b/i.test(t) && /\b(what time|when|time|until|early|late)\b/i.test(t)) return { intent: 'policy', to: 'faq', confidence: 0.9, rule: 'policy_times' }
  // A question in the middle of a booking is answered, then the booking resumes
  if (isHoursQuestion(t) && !/\b(book|appointment|reserve)\b/i.test(t)) return { intent: 'hours', to: 'faq', confidence: 0.9, rule: 'hours' }
  if (PRICE.test(t) && !/\b(book|reserve)\b/i.test(t)) return { intent: 'prices', to: 'faq', confidence: 0.85, rule: 'prices' }
  if (i.vertical === 'hotel' && POLICY.test(t) && !BOOK_HOTEL.test(t)) return { intent: 'policy', to: 'faq', confidence: 0.85, rule: 'policy' }
  const book = i.vertical === 'dental' ? BOOK_DENTAL : BOOK_HOTEL
  if (book.test(t)) return { intent: 'booking', to: 'booking', confidence: 0.9, rule: 'booking_request' }
  // A side question during a booking ("is there parking?") goes to the FAQ agent; the booking resumes after.
  const question = /\?\s*$|^(sorry,?\s*)?(do|does|is|are|can|what|where|when|how|which|who)\b/i.test(t)
  const slotSignal = /\d|\b(today|tomorrow|morning|afternoon|evening|monday|tuesday|wednesday|thursday|friday|saturday|sunday|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|night|guest|adult|room|double|twin|suite|first|second|that one|okay|ok|fine)\b/i.test(t)
  if (i.bookingActive && question && !slotSignal) return { intent: 'faq', to: 'faq', confidence: 0.7, rule: 'side_question' }
  if (i.bookingActive) return { intent: 'booking', to: 'booking', confidence: 0.8, rule: 'booking_slot_fill' }
  if (/\?|^(do|does|is|are|can|what|where|when|how|which|who)\b/i.test(t)) return { intent: 'faq', to: 'faq', confidence: 0.7, rule: 'question' }
  return { intent: 'unknown', to: 'faq', confidence: 0.4, rule: 'no_rule' }
}
