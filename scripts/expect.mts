/** Shared turn expectations for the eval gate and the replay harness. */
import type { TurnResult } from '../server/agentTurn.ts'

export interface Expect {
  route?: string
  match?: string[]
  not_match?: string[]
  outcome?: string[]
  step?: string
  handoff?: boolean
  emergency?: boolean
  ticket?: boolean
  ticket_priority?: string
  /** reply must carry >=1 retrieval citation (multi-agent path) */
  cited?: boolean
  /** guard must pass (no ungrounded price/time, no PII) */
  guard_ok?: boolean
}
export interface EvalCase {
  id: string
  business?: string
  description: string
  after_hours?: boolean
  turns: Array<{ text: string; expect: Expect }>
  /** replay fixtures only */
  scenario?: string
  tags?: string[]
}

export function checkTurn(r: TurnResult, e: Expect): string[] {
  const errs: string[] = []
  if (e.route && r.route !== e.route) errs.push(`route ${r.route} != ${e.route}`)
  for (const m of e.match ?? []) if (!new RegExp(m, 'i').test(r.text)) errs.push(`missing /${m}/`)
  for (const m of e.not_match ?? []) if (new RegExp(m, 'i').test(r.text)) errs.push(`forbidden /${m}/`)
  if (e.outcome && !e.outcome.includes(String(r.outcome))) errs.push(`outcome ${r.outcome} not in [${e.outcome}]`)
  if (e.step && r.step !== e.step) errs.push(`step ${r.step} != ${e.step}`)
  if (e.handoff !== undefined && r.handoff !== e.handoff) errs.push(`handoff ${r.handoff} != ${e.handoff}`)
  if (e.emergency !== undefined && Boolean(r.booking.isEmergency) !== e.emergency) errs.push(`emergency ${r.booking.isEmergency} != ${e.emergency}`)
  if (e.ticket && !r.reply?.createTicket) errs.push('no ticket')
  const prio = r.reply?.createTicket?.priority
  if (e.ticket_priority && prio !== e.ticket_priority) errs.push(`ticket priority ${prio} != ${e.ticket_priority}`)
  if (e.cited && r.citations.length === 0) errs.push('no citation')
  if (e.guard_ok !== undefined && r.guard.ok !== e.guard_ok) errs.push(`guard ok ${r.guard.ok} != ${e.guard_ok} ${JSON.stringify(r.guard.violations)}`)
  return errs
}

