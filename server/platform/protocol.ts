/**
 * Typed handoff protocol between agents. Every hop is a HandoffMessage that names the
 * sender, the receiver, the tenant and the reason; the orchestrator validates it before
 * the receiving agent runs (unknown receiver or a tenant id that differs from the call's
 * tenant is rejected). Agents return an AgentReply; they never call each other directly.
 */
export type AgentName = 'orchestrator' | 'triage' | 'faq' | 'booking' | 'guard' | 'human'
export type Intent =
  | 'greeting' | 'hours' | 'prices' | 'policy' | 'faq' | 'booking' | 'confirm_yes' | 'confirm_no'
  | 'emergency' | 'human' | 'goodbye' | 'unknown' | 'injection'

export interface HandoffMessage {
  type: 'handoff'
  from: AgentName
  to: AgentName
  tenantId: string
  callId: string
  turnId: number
  intent: Intent
  reason: string
  confidence: number
}

export interface ToolCallRecord {
  agent: AgentName
  tool: string
  ok: boolean
  error?: string
  ms: number
}

export interface AgentReply {
  type: 'reply'
  agent: AgentName
  text: string
  /** where the words came from: config tool / template, or a model */
  source: 'tool' | 'template' | 'llm'
  /** text the reply may draw facts from (guard grounding) */
  grounding: string[]
  citations: string[]
  model: string | null
  tokens: { prompt: number; completion: number } | null
  /** agent asks the orchestrator to hand the caller to a human */
  escalate?: { reason: string }
  decision: string
}

const SPECIALISTS = new Set<AgentName>(['faq', 'booking', 'guard', 'human'])

export function validateHandoff(m: HandoffMessage, session: { tenantId: string; callId: string }): string | null {
  if (m.type !== 'handoff') return 'not a handoff'
  if (!SPECIALISTS.has(m.to)) return `unknown receiver ${m.to}`
  if (m.tenantId !== session.tenantId) return 'cross_tenant_handoff'
  if (m.callId !== session.callId) return 'wrong_call'
  if (!m.reason) return 'missing reason'
  return null
}
