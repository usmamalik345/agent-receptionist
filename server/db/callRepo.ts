/** SQL call log (calls + call_turns). Tenant-scoped like every repository; no caller words stored. */
import { applyTurn, type CallLog, type CallRecord, type TurnRecord } from '../platform/callLog.ts'
import type { Db, Row } from './sql.ts'

const iso = (v: unknown) => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v))

const toCall = (r: Row): CallRecord => ({
  id: String(r.id), tenantId: String(r.tenant_id), startedAt: iso(r.started_at)!, endedAt: iso(r.ended_at), turns: Number(r.turns),
  escalated: Boolean(Number(r.escalated)), outcome: (r.outcome as CallRecord['outcome']) ?? null, bookingRef: (r.booking_ref as string | null) ?? null,
})
const toTurn = (r: Row): TurnRecord => ({
  tenantId: String(r.tenant_id), callId: String(r.call_id), turn: Number(r.turn), traceId: String(r.trace_id), agent: String(r.agent), intent: String(r.intent),
  tools: JSON.parse(String(r.tools)) as string[], escalated: Boolean(Number(r.escalated)), guardBlocked: Boolean(Number(r.guard_blocked)),
  bookingRef: (r.booking_ref as string | null) ?? null, latencyMs: Number(r.latency_ms), replyChars: Number(r.reply_chars), at: iso(r.at)!,
})

export class SqlCallLog implements CallLog {
  private readonly db: Db
  constructor(db: Db) {
    this.db = db
  }
  async callStarted(tenantId: string, callId: string, at: string) {
    await this.db.tenantTx(tenantId, (q) => q.query('INSERT INTO calls (tenant_id, id, started_at) VALUES ($1, $2, $3) ON CONFLICT (tenant_id, id) DO NOTHING', [tenantId, callId, at]))
  }
  async turnRecorded(r: TurnRecord) {
    await this.db.tenantTx(r.tenantId, async (q) => {
      const rows = await q.query('SELECT * FROM calls WHERE tenant_id = $1 AND id = $2', [r.tenantId, r.callId])
      if (!rows.length) return
      await q.query(
        `INSERT INTO call_turns (tenant_id, call_id, turn, trace_id, agent, intent, tools, escalated, guard_blocked, booking_ref, latency_ms, reply_chars, at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) ON CONFLICT (tenant_id, call_id, turn) DO NOTHING`,
        [r.tenantId, r.callId, r.turn, r.traceId, r.agent, r.intent, JSON.stringify(r.tools), r.escalated ? 1 : 0, r.guardBlocked ? 1 : 0, r.bookingRef, r.latencyMs, r.replyChars, r.at],
      )
      const c = applyTurn(toCall(rows[0]), r)
      await q.query('UPDATE calls SET turns = $3, escalated = $4, outcome = $5, booking_ref = $6 WHERE tenant_id = $1 AND id = $2', [r.tenantId, r.callId, c.turns, c.escalated ? 1 : 0, c.outcome, c.bookingRef])
    })
  }
  async callEnded(tenantId: string, callId: string, at: string) {
    await this.db.tenantTx(tenantId, (q) => q.query('UPDATE calls SET ended_at = $3 WHERE tenant_id = $1 AND id = $2', [tenantId, callId, at]))
  }
  async listCalls(tenantId: string, limit = 100) {
    const n = Math.max(1, Math.min(500, Math.floor(limit)))
    return this.db.tenantTx(tenantId, async (q) => (await q.query('SELECT * FROM calls WHERE tenant_id = $1 ORDER BY started_at DESC, id LIMIT $2', [tenantId, n])).map(toCall))
  }
  async listTurns(tenantId: string, callId: string) {
    return this.db.tenantTx(tenantId, async (q) => (await q.query('SELECT * FROM call_turns WHERE tenant_id = $1 AND call_id = $2 ORDER BY turn', [tenantId, callId])).map(toTurn))
  }
}
