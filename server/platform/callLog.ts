/**
 * Call log: one row per call and one per turn, tenant-scoped like the booking store.
 * Stores what ops needs (agent, intent, tools, outcome, latency) and never the caller's words.
 * Browser-safe interface + in-memory implementation; the SQL one lives in server/db/.
 */
export interface CallRecord {
  id: string
  tenantId: string
  startedAt: string
  endedAt: string | null
  turns: number
  escalated: boolean
  outcome: 'booked' | 'transferred' | null
  bookingRef: string | null
}

export interface TurnRecord {
  tenantId: string
  callId: string
  turn: number
  traceId: string
  agent: string
  intent: string
  tools: string[]
  escalated: boolean
  guardBlocked: boolean
  bookingRef: string | null
  latencyMs: number
  replyChars: number
  at: string
}

export interface CallLog {
  callStarted(tenantId: string, callId: string, at: string): Promise<void>
  turnRecorded(r: TurnRecord): Promise<void>
  callEnded(tenantId: string, callId: string, at: string): Promise<void>
  /** newest first */
  listCalls(tenantId: string, limit?: number): Promise<CallRecord[]>
  listTurns(tenantId: string, callId: string): Promise<TurnRecord[]>
}

/** Fold one turn into its call row (shared by the memory and SQL logs). */
export function applyTurn(c: CallRecord, r: TurnRecord): CallRecord {
  return {
    ...c,
    turns: Math.max(c.turns, r.turn),
    escalated: c.escalated || r.escalated,
    bookingRef: c.bookingRef ?? r.bookingRef,
    outcome: r.bookingRef || c.outcome === 'booked' ? 'booked' : c.escalated || r.escalated ? 'transferred' : c.outcome,
  }
}

export class MemoryCallLog implements CallLog {
  private readonly calls = new Map<string, Map<string, CallRecord>>()
  private readonly turnRows = new Map<string, TurnRecord[]>()
  private readonly max: number
  /** keeps the newest `maxCallsPerTenant` calls per tenant (bounded memory for the demo) */
  constructor(maxCallsPerTenant = 500) {
    this.max = maxCallsPerTenant
  }
  private bucket(tenantId: string) {
    let b = this.calls.get(tenantId)
    if (!b) this.calls.set(tenantId, (b = new Map()))
    return b
  }
  async callStarted(tenantId: string, callId: string, at: string) {
    const b = this.bucket(tenantId)
    b.set(callId, { id: callId, tenantId, startedAt: at, endedAt: null, turns: 0, escalated: false, outcome: null, bookingRef: null })
    if (b.size > this.max) {
      const oldest = b.keys().next().value as string
      b.delete(oldest)
      this.turnRows.delete(`${tenantId}/${oldest}`)
    }
  }
  async turnRecorded(r: TurnRecord) {
    const c = this.bucket(r.tenantId).get(r.callId)
    if (!c) return
    this.bucket(r.tenantId).set(r.callId, applyTurn(c, r))
    const k = `${r.tenantId}/${r.callId}`
    this.turnRows.set(k, [...(this.turnRows.get(k) ?? []), { ...r, tools: [...r.tools] }])
  }
  async callEnded(tenantId: string, callId: string, at: string) {
    const c = this.bucket(tenantId).get(callId)
    if (c) c.endedAt = at
  }
  async listCalls(tenantId: string, limit = 100) {
    return [...this.bucket(tenantId).values()].reverse().slice(0, limit).map((c) => ({ ...c }))
  }
  async listTurns(tenantId: string, callId: string) {
    return (this.turnRows.get(`${tenantId}/${callId}`) ?? []).map((r) => ({ ...r, tools: [...r.tools] }))
  }
}
