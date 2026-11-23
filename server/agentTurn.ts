/**
 * Server-side turn pipeline: router -> (hand-off | latency ladder -> existing rule engine),
 * one trace per call, router decisions logged. Used by POST /api/agent/turn, the eval
 * gate and the replay tests. Never sends WhatsApp/SMS or calls paid APIs.
 */
import { randomUUID } from 'node:crypto'
import { resolveBusiness } from '../src/businesses/index.ts'
import { setActiveBusiness } from '../src/lib/businessRuntime.ts'
import { greet, processGuestMessage } from '../src/lib/stateMachine.ts'
import { emptyBooking, type BookingFields, type ConversationStep, type Language } from '../src/lib/types.ts'
import { AnswerCache, loadLatencyConfig, respondWithinBudget, TokenBudget, type LatencyConfig, type Responder } from './latency.ts'
import { buildRetrievalCorpus, ClarificationTracker, HANDOFF_TEXT, isFailedClarification, routeTurn, type RouterDecision } from './router.ts'
import { CallTrace, defaultTraceSink, jsonlSink, logRouterDecision, redactText, ROUTER_DECISIONS_FILE, type Sink, type TraceSource, type TurnTrace } from './tracing.ts'

export type EngineReply = ReturnType<typeof processGuestMessage>

interface AgentSession {
  callId: string
  business: string
  industry: string
  step: ConversationStep
  booking: BookingFields
  language: Language
  afterHours: boolean
  trace: CallTrace
}

export interface AgentRuntimeOptions {
  config?: LatencyConfig
  enforceRouter?: boolean
  traceSink?: Sink
  decisionSink?: Sink
  stdout?: boolean
  storeText?: boolean
  /** Wrap/replace the primary responder (tests inject a slow LLM here). */
  primary?: (engine: Responder) => Responder
  fallback?: (engine: Responder) => Responder
}

export interface TurnResult {
  callId: string
  text: string
  firstAudioText: string
  route: RouterDecision['route']
  decision: RouterDecision
  outcome: string | null
  step: ConversationStep
  handoff: boolean
  reply: EngineReply | null
  trace: TurnTrace
  booking: BookingFields
}

export class AgentRuntime {
  readonly config: LatencyConfig
  readonly cache: AnswerCache
  readonly tokens: TokenBudget
  readonly clarifications = new ClarificationTracker()
  private readonly sessions = new Map<string, AgentSession>()
  private readonly opts: AgentRuntimeOptions

  constructor(opts: AgentRuntimeOptions = {}) {
    this.opts = opts
    this.config = opts.config ?? loadLatencyConfig()
    this.cache = new AnswerCache(this.config.cacheTtlMs)
    this.tokens = new TokenBudget(this.config.maxTokensPerCall)
  }

  start(input: { callId?: string; business?: string; afterHours?: boolean; source?: TraceSource; channel?: string } = {}) {
    const biz = resolveBusiness(input.business)
    setActiveBusiness(biz)
    const callId = input.callId || randomUUID()
    const g = greet('en', Boolean(input.afterHours))
    this.sessions.set(callId, {
      callId,
      business: biz.slug,
      industry: biz.industry,
      step: g.nextStep,
      booking: { ...emptyBooking('en'), ...g.bookingUpdates },
      language: 'en',
      afterHours: Boolean(input.afterHours),
      trace: new CallTrace(callId, {
        source: input.source ?? 'server',
        business: biz.slug,
        channel: input.channel ?? 'voice',
        sink: this.opts.traceSink ?? defaultTraceSink(),
      }),
    })
    return { callId, greeting: g.text, step: g.nextStep }
  }

  has(callId: string): boolean {
    return this.sessions.has(callId)
  }

  end(callId: string): void {
    this.sessions.delete(callId)
    this.clarifications.reset(callId)
  }

  private logDecision(d: RouterDecision): void {
    logRouterDecision(d, this.opts.decisionSink ?? jsonlSink(ROUTER_DECISIONS_FILE), this.opts.stdout ?? true)
  }

  async turn(callId: string, text: string, extra: { endpointingMs?: number; sttMs?: number } = {}): Promise<TurnResult> {
    const s = this.sessions.get(callId)
    if (!s) throw new Error(`unknown call ${callId}`)
    const biz = resolveBusiness(s.business)
    setActiveBusiness(biz)
    const stepBefore = s.step
    const tb = s.trace.startTurn({
      step_before: stepBefore,
      endpointing_ms: extra.endpointingMs ?? null,
      stt_ms: extra.sttMs ?? null,
      ...(this.opts.storeText ? { user_text: redactText(text) } : {}),
    })

    const decision = await tb.span('router', () =>
      routeTurn(text, {
        callId,
        turnId: tb.record.turn_id,
        step: s.step,
        industry: s.industry,
        corpus: buildRetrievalCorpus(biz),
        failedClarifications: this.clarifications.get(callId),
      }),
    )
    this.logDecision(decision)
    const { reason, confidence, matched_rule, intent, latency_ms } = decision
    tb.set({ route: decision.route, intent, router: { reason, confidence, matched_rule, intent, latency_ms } })
    const result = (r: Omit<TurnResult, 'callId' | 'decision' | 'trace' | 'booking'>): TurnResult => ({
      ...r, callId, decision, trace: tb.end(), booking: s.booking,
    })

    // Enforced hand-off on low confidence / repeated failures (explicit asks use the engine's own escalation)
    if (this.opts.enforceRouter && decision.route === 'human' && intent !== 'human') {
      await tb.span('tool', () => undefined, { tool: 'escalate_to_human', reason })
      s.step = 'escalated'
      tb.set({
        handoff: true, outcome: 'transferred', step_after: s.step, reply_chars: HANDOFF_TEXT.length, model: 'none',
        tool_calls: [{ tool: 'escalate_to_human', ok: true, result: reason }], first_audio_ready_ms: tb.elapsed(),
      })
      return result({ text: HANDOFF_TEXT, firstAudioText: HANDOFF_TEXT, route: 'human', outcome: 'transferred', step: s.step, handoff: true, reply: null })
    }

    const engine: Responder = {
      name: 'rule-engine',
      respond: async ({ text: t }) => {
        const reply = processGuestMessage({
          text: t,
          step: s.step === 'idle' ? 'await_intent' : s.step,
          booking: s.booking,
          language: s.language,
          afterHours: s.afterHours,
          humanTakeover: false,
        })
        return { text: reply.text, payload: reply }
      },
    }
    const primary = this.opts.primary ? this.opts.primary(engine) : engine
    const fallback = this.opts.fallback ? this.opts.fallback(engine) : engine
    const spanName = this.opts.primary || this.config.primaryModel !== 'rule-engine' ? 'llm' : 'engine'
    const ladder = await tb.span(spanName, () =>
      respondWithinBudget(callId, s.business, text, { config: this.config, primary, fallback, cache: this.cache, tokens: this.tokens }),
    )

    if (ladder.fallback) {
      this.logDecision({
        ...decision,
        ts: new Date().toISOString(),
        route: ladder.handoff ? 'human' : decision.route,
        reason: `fallback:${ladder.fallback.step}`,
        fallback_reason: ladder.fallback.reason,
      })
      tb.addSpan({ name: 'fallback', start_ms: ladder.firstAudioAtMs, duration_ms: 0, ok: true, attrs: { ...ladder.fallback } })
    }

    const reply = (ladder.payload as EngineReply | undefined) ?? null
    let failed = false
    if (reply) {
      failed = isFailedClarification(stepBefore, reply, s.booking)
      s.booking = { ...s.booking, ...reply.bookingUpdates }
      s.step = reply.nextStep
    } else if (ladder.handoff) {
      s.step = 'escalated'
    }
    this.clarifications.record(callId, failed)
    const outcome = reply ? (reply.outcome ?? null) : ladder.handoff ? 'transferred' : null
    const handoff = ladder.handoff || reply?.escalate === true

    tb.set({
      step_after: s.step,
      outcome,
      intent: reply?.intent ?? intent,
      failed_clarification: failed,
      handoff,
      fallback: ladder.fallback ? { ...ladder.fallback } : null,
      model: ladder.model,
      tokens: ladder.tokens,
      llm_ttft_ms: ladder.ttftMs,
      reply_chars: ladder.text.length,
      first_audio_ready_ms: ladder.firstAudioAtMs,
      tool_calls: (reply?.toolCalls ?? []).map((t) => ({ tool: t.tool, ok: true, result: String(t.result).slice(0, 80) })),
    })
    return result({
      text: ladder.text,
      firstAudioText: ladder.firstAudioText,
      route: ladder.handoff ? 'human' : decision.route,
      outcome,
      step: s.step,
      handoff,
      reply,
    })
  }
}
