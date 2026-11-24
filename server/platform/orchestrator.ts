/**
 * Orchestrator: one per process, serves every tenant. Per turn:
 *   rate limit (per tenant) -> injection screen (before any tool) -> triage agent
 *   -> typed handoff -> specialist agent (faq | booking | human) with its own tool allow-list
 *   -> guard agent (grounding, PII, cross-tenant leak) -> humanize -> sentence chunks for TTS.
 * Calls are bound to the tenant that started them: a call id used with another tenant id is
 * "not found" (no existence leak). One trace per turn with a span per agent and per tool.
 */
import { randomUUID } from 'node:crypto'
import { SAFE_LINE } from '../agents/guard.ts'
import { createResponseCache, type ResponseCache } from '../cache.ts'
import { loadLatencyConfig, SilenceMonitor, TokenBudget, type LatencyConfig, type SilenceAction } from '../latency.ts'
import { loadLlmClient, type LlmClient } from '../llm.ts'
import { CallTrace, defaultTraceSink, type Sink, type TurnTrace } from '../tracing.ts'
import { emptyBooking, localToday, resumePrompt, runBookingAgent, type BookingState } from './agents/booking.ts'
import { CLARIFY_TEXT, runFaqAgent } from './agents/faq.ts'
import { buildLeakIndex, runGuardAgent, type LeakIndex } from './agents/guard.ts'
import { triage, type TriageResult } from './agents/triage.ts'
import { INJECTION_REPLY, screenInjection } from './injection.ts'
import { silentLogger, type Logger } from './logger.ts'
import { validateHandoff, type AgentName, type AgentReply, type HandoffMessage, type ToolCallRecord } from './protocol.ts'
import { TenantRateLimiter } from './rateLimit.ts'
import { MemoryBookingStore, type BookingStore } from './store.ts'
import { humanize, sentences } from './speech.ts'
import type { Tenant } from './tenant.ts'
import { callTool, type ToolContext } from './tools.ts'

export class PlatformError extends Error {
  readonly status: number
  readonly retryAfterMs?: number
  constructor(status: number, message: string, retryAfterMs?: number) {
    super(message)
    this.status = status
    this.retryAfterMs = retryAfterMs
  }
}

interface Session {
  callId: string
  tenantId: string
  trace: CallTrace
  booking: BookingState
  callerTexts: string[]
  failedClarifications: number
  escalated: boolean
  turn: number
}

export interface PlatformOptions {
  tenants: Map<string, Tenant>
  store?: BookingStore
  llm?: LlmClient
  cache?: ResponseCache
  config?: LatencyConfig
  traceSink?: Sink
  logger?: Logger
  now?: () => Date
  defaultRateLimitPerMinute?: number
  /** eval/test hook: tool name that fails */
  failTool?: string | null
}

export interface PlatformTurnResult {
  callId: string
  tenantId: string
  text: string
  /** sentence chunks, in order, for streaming TTS */
  chunks: string[]
  agent: AgentName
  intent: string
  handoffs: Array<{ from: AgentName; to: AgentName; reason: string }>
  tools: ToolCallRecord[]
  escalated: boolean
  guard: { ok: boolean; blocked: boolean; violations: string[]; crossTenant: string[] }
  injection: string[]
  booking: { ref: string; kind: string } | null
  pendingConfirmation: boolean
  tokens: { prompt: number; completion: number } | null
  trace: TurnTrace
}

export const HUMAN_HANDOFF_TEXT = "Of course. I'll pass you to a member of the team now; they'll pick up shortly."

export class Platform {
  readonly tenants: Map<string, Tenant>
  readonly store: BookingStore
  readonly llm: LlmClient
  readonly cache: ResponseCache
  readonly config: LatencyConfig
  readonly tokens: TokenBudget
  readonly silenceMonitor: SilenceMonitor
  readonly limiter = new TenantRateLimiter()
  readonly leak: LeakIndex
  private readonly sessions = new Map<string, Session>()
  private readonly opts: PlatformOptions
  private readonly log: Logger

  constructor(opts: PlatformOptions) {
    this.opts = opts
    this.tenants = opts.tenants
    this.store = opts.store ?? new MemoryBookingStore()
    this.config = opts.config ?? loadLatencyConfig()
    this.llm = opts.llm ?? loadLlmClient()
    this.cache = opts.cache ?? createResponseCache(process.env, this.config.cacheTtlMs)
    this.tokens = new TokenBudget(this.config.maxTokensPerCall)
    this.silenceMonitor = new SilenceMonitor(this.config.callerSilenceMs)
    this.leak = buildLeakIndex(this.tenants.values())
    this.log = opts.logger ?? silentLogger
  }

  private tenant(id: string): Tenant {
    const t = this.tenants.get(id)
    if (!t) throw new PlatformError(404, 'unknown tenant')
    return t
  }
  private session(tenantId: string, callId: string): Session {
    const s = this.sessions.get(callId)
    // Same error for "no such call" and "call belongs to another tenant": no existence leak
    if (!s || s.tenantId !== tenantId) throw new PlatformError(404, 'unknown call')
    return s
  }
  private limit(t: Tenant): void {
    const wait = this.limiter.take(t.id, t.rateLimitPerMinute ?? this.opts.defaultRateLimitPerMinute ?? 120)
    if (wait > 0) {
      this.log.warn('rate_limited', { tenant: t.id, retry_after_ms: wait })
      throw new PlatformError(429, 'rate limited', wait)
    }
  }

  start(tenantId: string, input: { callId?: string } = {}) {
    const t = this.tenant(tenantId)
    this.limit(t)
    const callId = input.callId && !this.sessions.has(input.callId) ? input.callId : randomUUID()
    this.sessions.set(callId, {
      callId, tenantId, booking: emptyBooking(), callerTexts: [], failedClarifications: 0, escalated: false, turn: 0,
      trace: new CallTrace(callId, { source: 'server', business: t.id, channel: 'voice', sink: this.opts.traceSink ?? defaultTraceSink() }),
    })
    const greeting = `Hi, you're through to ${t.name.replace(/\s*\(SAMPLE\)\s*/i, '')}, this is ${t.voice.agentName}. How can I help?`
    this.log.info('call_start', { tenant: t.id, call_id: callId, vertical: t.vertical })
    return { callId, tenantId, greeting, chunks: sentences(greeting), voice: t.voice, sample: t.sample }
  }

  end(tenantId: string, callId: string): void {
    this.session(tenantId, callId)
    this.sessions.delete(callId)
    this.silenceMonitor.reset(callId)
    this.log.info('call_end', { tenant: tenantId, call_id: callId })
  }

  silence(tenantId: string, callId: string, silentMs: number): SilenceAction {
    const s = this.session(tenantId, callId)
    const a = this.silenceMonitor.check(callId, silentMs)
    if (a.action === 'handoff') s.escalated = true
    if (a.action !== 'wait') this.log.info('caller_silence', { tenant: tenantId, call_id: callId, action: a.action, silent_ms: silentMs })
    return a
  }

  bookings(tenantId: string) {
    this.tenant(tenantId)
    return this.store.list(tenantId)
  }

  async turn(tenantId: string, callId: string, rawText: string): Promise<PlatformTurnResult> {
    const t = this.tenant(tenantId)
    const s = this.session(tenantId, callId)
    this.limit(t)
    const text = String(rawText ?? '').slice(0, 500).trim()
    s.turn++
    s.callerTexts.push(text)
    this.silenceMonitor.reset(callId)
    const tb = s.trace.startTurn({ step_before: s.booking.expecting ?? (s.booking.active ? 'booking' : 'idle') })
    const tools: ToolCallRecord[] = []
    const handoffs: PlatformTurnResult['handoffs'] = []
    const ctx: ToolContext = { tenant: t, callId, store: this.store, confirmedId: null, failTool: this.opts.failTool ?? null }
    const agentSpan = async <T>(agent: AgentName, fn: () => Promise<T> | T, attrs: (out: T) => Record<string, unknown>) => {
      const t0 = tb.elapsed()
      const start = performance.now()
      const out = await fn()
      tb.addSpan({ name: `agent:${agent}`, start_ms: t0, duration_ms: Math.round((performance.now() - start) * 100) / 100, ok: true, attrs: { agent, ...attrs(out) } })
      return out
    }

    // 1) Injection screen - before triage and before any tool can run
    const inj = screenInjection(text)
    let reply: AgentReply
    let tr: TriageResult
    if (inj.flagged) {
      tr = { intent: 'injection', to: 'guard', confidence: 1, rule: `injection:${inj.rules.join(',')}` }
      tb.addSpan({ name: 'agent:guard', start_ms: tb.elapsed(), duration_ms: 0, ok: true, attrs: { agent: 'guard', decision: 'injection_blocked', rules: inj.rules, tools: 0 } })
      reply = { type: 'reply', agent: 'guard', text: INJECTION_REPLY, source: 'template', grounding: [], citations: [], model: null, tokens: null, decision: 'injection_blocked' }
      this.log.warn('injection_blocked', { tenant: t.id, call_id: callId, rules: inj.rules })
    } else {
      // 2) Triage agent
      tr = await agentSpan('triage', () => triage({ text, vertical: t.vertical, bookingActive: s.booking.active, confirmationPending: Boolean(s.booking.pending) }), (r) => ({ decision: r.intent, to: r.to, confidence: r.confidence, rule: r.rule, tokens: null, model: 'rules' }))
      const msg: HandoffMessage = { type: 'handoff', from: 'triage', to: tr.to, tenantId: t.id, callId, turnId: s.turn, intent: tr.intent, reason: tr.rule, confidence: tr.confidence }
      const bad = validateHandoff(msg, s)
      if (bad) throw new PlatformError(500, `handoff rejected: ${bad}`)
      handoffs.push({ from: 'triage', to: tr.to, reason: tr.rule })

      // 3) Specialist
      if (tr.to === 'human') {
        reply = await this.humanHandoff(t, ctx, tools, 'caller_asked')
      } else if (tr.to === 'booking') {
        if (tr.intent === 'confirm_yes' && s.booking.pending) ctx.confirmedId = s.booking.pending.id
        const intent = tr.intent === 'confirm_yes' || tr.intent === 'confirm_no' ? tr.intent : 'booking'
        reply = await agentSpan('booking', () => runBookingAgent({ tenant: t, ctx, tools, today: localToday(t.timezone, this.opts.now?.() ?? new Date()) }, s.booking, text, intent), (r) => ({ decision: r.decision, tools: tools.filter((x) => x.agent === 'booking').map((x) => `${x.tool}:${x.ok ? 'ok' : x.error}`), tokens: null, model: null }))
      } else {
        const faq = await agentSpan('faq', () => runFaqAgent({ tenant: t, ctx, llm: this.llm, cache: this.cache, config: this.config, tokens: this.tokens, callId, tools }, text, tr), (r) => ({ decision: r.decision, tools: tools.filter((x) => x.agent === 'faq').map((x) => `${x.tool}:${x.ok ? 'ok' : x.error}`), tokens: r.tokens, model: r.model, ttft_ms: r.llmMeta?.ttftMs ?? null, cache_hit: r.llmMeta?.cacheHit ?? false, fallback: r.llmMeta?.fallback ?? null }))
        reply = faq
        if (faq.decision === 'no_grounded_passage') s.failedClarifications++
        else s.failedClarifications = 0
        if (s.failedClarifications >= 2) reply = await this.humanHandoff(t, ctx, tools, 'repeated_clarification_failure')
        else if (s.booking.active && faq.source !== 'llm' && tr.intent !== 'goodbye') {
          const next = resumePrompt(s.booking)
          if (next) reply = { ...reply, text: `${reply.text} ${next}` }
        }
        if (faq.llmMeta) tb.set({ llm_ttft_ms: faq.llmMeta.ttftMs, cache_hit: faq.llmMeta.cacheHit, fallback: faq.llmMeta.fallback ? { reason: faq.llmMeta.fallback, step: faq.llmMeta.step } : null } as never)
      }
      if (reply.escalate && tr.to !== 'human' && reply.agent !== 'orchestrator') {
        handoffs.push({ from: reply.agent, to: 'human', reason: reply.escalate.reason })
        const severe = reply.decision === 'emergency_severe'
        const h = await this.humanHandoff(t, ctx, tools, reply.escalate.reason)
        // severe symptoms: keep the safety line, then hand off
        reply = severe ? { ...reply, text: `${reply.text} I'm also passing you to a member of the team now.` } : { ...h, text: reply.decision.endsWith(':failed') ? reply.text : h.text }
      }
    }
    if (reply.agent === 'orchestrator' || (reply.escalate && reply.decision !== 'emergency_severe')) s.escalated = true
    if (reply.decision === 'emergency_severe') s.escalated = true

    // 4) Guard agent
    const g = await agentSpan('guard', () => runGuardAgent(t, reply, { callerTexts: s.callerTexts, callerPhone: s.booking.phone, leak: this.leak }), (r) => ({ decision: r.blocked ? 'blocked' : 'pass', violations: r.violations.map((v) => v.kind), cross_tenant: r.crossTenant, tokens: null }))
    let out = g.blocked ? SAFE_LINE : g.text
    if (!g.blocked && reply.source === 'llm' && reply.decision === 'llm:primary') void this.cache.set(this.cache.key(text, t.id, t.policyVersion), out)
    if (g.blocked) this.log.warn('guard_blocked', { tenant: t.id, call_id: callId, violations: g.violations.map((v) => v.kind), cross_tenant: g.crossTenant })
    out = humanize(out)
    const chunks = sentences(out)

    const tokens = reply.tokens
    tb.set({
      route: tr.to === 'booking' ? 'tool' : tr.to === 'human' || s.escalated ? 'human' : reply.source === 'llm' ? 'retrieval' : 'rule',
      intent: tr.intent, outcome: s.booking.done && reply.decision.endsWith(':ok') ? 'booked' : s.escalated ? 'transferred' : null,
      handoff: s.escalated, step_after: s.booking.expecting ?? (s.booking.active ? 'booking' : 'idle'), model: reply.model ?? 'none', tokens,
      reply_chars: out.length, agent_path: 'platform', citations: reply.citations,
      guard: { ok: g.ok, blocked: g.blocked, violations: g.violations }, tool_calls: tools.map((x) => ({ tool: x.tool, ok: x.ok, result: x.error ?? 'ok' })),
      tenant: t.id, vertical: t.vertical, handoffs, injection: inj.rules, router: { reason: tr.rule, confidence: tr.confidence, matched_rule: tr.rule, intent: tr.intent, latency_ms: 0 },
    } as never)
    for (const x of tools) tb.addSpan({ name: `tool:${x.tool}`, start_ms: 0, duration_ms: x.ms, ok: x.ok, error: x.error, attrs: { agent: x.agent, tool: x.tool } })
    const trace = tb.end()
    this.log.info('turn', { tenant: t.id, call_id: callId, turn: s.turn, intent: tr.intent, agent: reply.agent, tools: tools.map((x) => `${x.tool}:${x.ok ? 'ok' : x.error}`), guard_blocked: g.blocked, escalated: s.escalated, chars_in: text.length, chars_out: out.length })
    const booked = reply.decision.endsWith(':ok') && s.booking.done ? { ref: s.booking.done.ref, kind: s.booking.done.kind } : null
    return {
      callId, tenantId: t.id, text: out, chunks, agent: reply.agent, intent: tr.intent, handoffs, tools, escalated: s.escalated,
      guard: { ok: g.ok, blocked: g.blocked, violations: g.violations.map((v) => v.kind), crossTenant: g.crossTenant },
      injection: inj.rules, booking: booked, pendingConfirmation: Boolean(s.booking.pending), tokens, trace,
    }
  }

  private async humanHandoff(t: Tenant, ctx: ToolContext, tools: ToolCallRecord[], reason: string): Promise<AgentReply> {
    const r = await callTool('orchestrator', 'handoff_to_human', { reason }, ctx)
    tools.push(r.record)
    return { type: 'reply', agent: 'orchestrator', text: HUMAN_HANDOFF_TEXT, source: 'template', grounding: [], citations: [], model: null, tokens: null, decision: `handoff:${reason}` }
  }
}

export { CLARIFY_TEXT }
