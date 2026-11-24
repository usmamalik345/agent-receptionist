/**
 * Server-side turn pipeline:
 *   triage agent (intent + risk) -> router (rule | tool | retrieval | human, decision log)
 *   -> rule/tool: deterministic engine (+ side-effect tools under an armed deadline)
 *   -> retrieval: retrieval agent (BM25 over the business's own config, citations)
 *                 -> response agent (pluggable LLM, mock by default) behind the latency ladder
 *   -> guard (grounded prices/times, no PII leak, length cap) -> first audio.
 * One trace per turn, router decisions logged. Used by POST /api/agent/turn, the eval
 * gate, the replay harness and the tests. Never sends WhatsApp/SMS or calls paid APIs.
 * MULTI_AGENT=0 restores the engine-only path (guard + cache still run).
 */
import { randomUUID } from 'node:crypto'
import { resolveBusiness } from '../src/businesses/index.ts'
import { setActiveBusiness } from '../src/lib/businessRuntime.ts'
import { greet, processGuestMessage } from '../src/lib/stateMachine.ts'
import { emptyBooking, type BookingFields, type ConversationStep, type Language } from '../src/lib/types.ts'
import { guardReply, SAFE_LINE, type GuardResult } from './agents/guard.ts'
import { answerHoursQuestion } from './agents/hoursTool.ts'
import { runResponseAgent } from './agents/response.ts'
import { buildPassages, retrieve, type RetrievalResult } from './agents/retrieval.ts'
import { assessRisk } from './agents/triage.ts'
import { createResponseCache, type ResponseCache } from './cache.ts'
import { CallLedger, loadPriceTable, turnCostUsd, type PriceTable } from './cost.ts'
import { FILLER_TEXT, loadLatencyConfig, SilenceMonitor, type SilenceAction, respondWithinBudget, TokenBudget, type LadderResult, type LatencyConfig, type Responder } from './latency.ts'
import { loadLlmClient, type LlmClient } from './llm.ts'
import { buildRetrievalCorpus, ClarificationTracker, HANDOFF_TEXT, isFailedClarification, routeTurn, type RouterDecision } from './router.ts'
import { localTicketTool, runTool, validateToolCall, type ToolFn, type ToolRunResult } from './tools.ts'
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
  /** Caller's own words this call (grounding for echoed times / phones) */
  callerTexts: string[]
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
  /** Retrieval + response agents for retrieval turns (default env MULTI_AGENT != '0') */
  multiAgent?: boolean
  llm?: LlmClient
  cache?: ResponseCache
  prices?: PriceTable
  /** Side-effect tools (default: local in-memory ticket tool; nothing is sent) */
  tools?: Partial<Record<'create_ticket', ToolFn>>
  toolTimeoutMs?: number
  guardMaxChars?: number
}

export interface TurnExtra {
  endpointingMs?: number
  /** STT time already spent - it comes out of the first-audio budget */
  sttMs?: number
  /** Fired once, when the first thing the caller hears is ready (reply or filler at the deadline). */
  onFirstAudio?: (text: string, atMs: number, kind: 'reply' | 'filler') => void
}

export interface TurnResult {
  callId: string
  text: string
  firstAudioText: string
  /** ms after the transcript arrived when first audio was ready (reply or filler) */
  firstAudioAtMs: number
  route: RouterDecision['route']
  decision: RouterDecision
  outcome: string | null
  step: ConversationStep
  handoff: boolean
  reply: EngineReply | null
  trace: TurnTrace
  booking: BookingFields
  citations: string[]
  guard: GuardResult
  costUsd: number | null
  cacheHit: boolean
}

const STATELESS_STEPS = new Set<string>(['await_intent', 'faq', 'completed', 'greeted', 'idle'])

/** Emits filler at the deadline unless the real reply is ready first. */
class FirstAudioGate {
  text: string | null = null
  atMs = 0
  kind: 'reply' | 'filler' = 'reply'
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly t0 = performance.now()
  private readonly cb?: TurnExtra['onFirstAudio']
  constructor(deadlineMs: number, cb?: TurnExtra['onFirstAudio']) {
    this.cb = cb
    this.timer = setTimeout(() => this.emit(FILLER_TEXT, 'filler'), Math.max(0, deadlineMs))
    this.timer.unref?.()
  }
  emit(text: string, kind: 'reply' | 'filler'): void {
    if (this.text !== null) return
    clearTimeout(this.timer)
    this.text = text
    this.kind = kind
    this.atMs = Math.round((performance.now() - this.t0) * 100) / 100
    this.cb?.(text, this.atMs, kind)
  }
}

export class AgentRuntime {
  readonly config: LatencyConfig
  readonly cache: ResponseCache
  readonly tokens: TokenBudget
  readonly llm: LlmClient
  readonly prices: PriceTable
  readonly ledger = new CallLedger()
  readonly multiAgent: boolean
  readonly clarifications = new ClarificationTracker()
  readonly silenceMonitor: SilenceMonitor
  private readonly sessions = new Map<string, AgentSession>()
  private readonly opts: AgentRuntimeOptions

  constructor(opts: AgentRuntimeOptions = {}) {
    this.opts = opts
    this.config = opts.config ?? loadLatencyConfig()
    this.cache = opts.cache ?? createResponseCache(process.env, this.config.cacheTtlMs)
    this.tokens = new TokenBudget(this.config.maxTokensPerCall)
    this.llm = opts.llm ?? loadLlmClient()
    this.prices = opts.prices ?? loadPriceTable()
    this.multiAgent = opts.multiAgent ?? process.env.MULTI_AGENT !== '0'
    this.silenceMonitor = new SilenceMonitor(this.config.callerSilenceMs)
  }

  /**
   * Caller-silence budget (CALLER_SILENCE_MS). The transport calls this with the ms since our last audio
   * ended and no caller speech. First breach -> re-prompt; second consecutive breach -> hand-off.
   */
  silence(callId: string, silentMs: number): SilenceAction {
    const s = this.sessions.get(callId)
    if (!s) throw new Error(`unknown call ${callId}`)
    const a = this.silenceMonitor.check(callId, silentMs)
    if (a.action !== 'wait') {
      const tb = s.trace.startTurn({ step_before: s.step })
      if (a.action === 'handoff') s.step = 'escalated'
      tb.set({ route: a.action === 'handoff' ? 'human' : 'rule', outcome: a.action === 'handoff' ? 'transferred' : null, handoff: a.action === 'handoff', step_after: s.step, reply_chars: a.text.length, model: 'none', silence_ms: silentMs, agent_path: 'engine' } as never)
      tb.end()
    }
    return a
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
      callerTexts: [],
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

  async turn(callId: string, text: string, extra: TurnExtra = {}): Promise<TurnResult> {
    const s = this.sessions.get(callId)
    if (!s) throw new Error(`unknown call ${callId}`)
    const biz = resolveBusiness(s.business)
    setActiveBusiness(biz)
    s.callerTexts.push(text)
    this.silenceMonitor.reset(callId)
    const stepBefore = s.step
    const sttMs = extra.sttMs ?? 0
    const gate = new FirstAudioGate(this.config.budgetMs - this.config.headroomMs - sttMs, extra.onFirstAudio)
    const tb = s.trace.startTurn({
      step_before: stepBefore,
      endpointing_ms: extra.endpointingMs ?? null,
      stt_ms: extra.sttMs ?? null,
      ...(this.opts.storeText ? { user_text: redactText(text) } : {}),
    })

    // 1) Triage agent + router
    const decision = await tb.span('router', () => {
      const d = routeTurn(text, {
        callId,
        turnId: tb.record.turn_id,
        step: s.step,
        industry: s.industry,
        corpus: buildRetrievalCorpus(biz),
        failedClarifications: this.clarifications.get(callId),
      })
      d.triage = { intent: d.intent, risk: assessRisk(text, d.intent), confidence: d.confidence, model: 'rules' }
      d.budget = { ttfa_target_ms: this.config.budgetMs, tokens_used: this.tokens.usedBy(callId), token_cap: this.config.maxTokensPerCall }
      return d
    })
    this.logDecision(decision)
    const { reason, confidence, matched_rule, intent, latency_ms } = decision
    const risk = decision.triage!.risk
    tb.set({ route: decision.route, intent, risk, router: { reason, confidence, matched_rule, intent, latency_ms } })

    const allowedContacts = [...biz.locations.map((l) => l.phone), s.booking.phone].filter(Boolean)
    const engineGrounding = () => [...buildPassages(biz).map((p) => p.text), ...s.callerTexts, JSON.stringify(s.booking)]
    const finishTurn = (r: {
      text: string
      route: RouterDecision['route']
      outcome: string | null
      handoff: boolean
      reply: EngineReply | null
      citations?: string[]
      guard: GuardResult
      costUsd: number | null
      cacheHit: boolean
    }): TurnResult => {
      gate.emit(r.text, 'reply')
      tb.set({ first_audio_ready_ms: gate.atMs, first_audio_kind: gate.kind })
      return {
        ...r,
        citations: r.citations ?? [],
        callId,
        decision,
        firstAudioText: gate.text!,
        firstAudioAtMs: gate.atMs,
        step: s.step,
        trace: tb.end(),
        booking: s.booking,
      }
    }

    // 2) Enforced hand-off on low confidence / repeated failures (explicit asks use the engine's own escalation)
    if (this.opts.enforceRouter && decision.route === 'human' && intent !== 'human') {
      await tb.span('tool', () => undefined, { tool: 'escalate_to_human', reason })
      s.step = 'escalated'
      const guard = guardReply({ text: HANDOFF_TEXT, source: 'engine', grounding: engineGrounding(), allowedContacts, maxChars: this.opts.guardMaxChars })
      tb.set({
        handoff: true, outcome: 'transferred', step_after: s.step, reply_chars: HANDOFF_TEXT.length, model: 'none', agent_path: 'engine',
        tool_calls: [{ tool: 'escalate_to_human', ok: true, result: reason }], guard: slimGuard(guard), cost_usd: 0, cache_hit: false,
      })
      this.ledger.addTurn(callId, { tokens: null, costUsd: 0, tokenCapHit: false, smallModel: false })
      return finishTurn({ text: HANDOFF_TEXT, route: 'human', outcome: 'transferred', handoff: true, reply: null, guard, costUsd: 0, cacheHit: false })
    }

    // 3) Deterministic engine (computed once; also the state source for retrieval turns)
    let engineMemo: EngineReply | null = null
    const runEngine = (t: string): EngineReply => {
      if (!engineMemo || t !== text) {
        // The engine reads a process-wide "active business". Turns are async, so another call
        // (other tenant) may have switched it since this turn started: re-pin it right before the sync call.
        setActiveBusiness(biz)
        const r = processGuestMessage({
          text: t,
          step: s.step === 'idle' ? 'await_intent' : s.step,
          booking: s.booking,
          language: s.language,
          afterHours: s.afterHours,
          humanTakeover: false,
        })
        if (t !== text) return r
        engineMemo = r
      }
      return engineMemo
    }
    const engine: Responder = { name: 'rule-engine', respond: async ({ text: t }) => { const reply = runEngine(t); return { text: reply.text, payload: reply } } }

    // 4) Retrieval route -> retrieval agent + response agent (only when the answer is stateless)
    let retrieval: RetrievalResult | null = null
    const engineReplyNow = decision.route === 'retrieval' ? runEngine(text) : null
    const useAgents =
      this.multiAgent &&
      !this.opts.primary &&
      decision.route === 'retrieval' &&
      engineReplyNow !== null &&
      STATELESS_STEPS.has(String(engineReplyNow.nextStep)) &&
      !engineReplyNow.createTicket &&
      engineReplyNow.intent === 'faq'
    if (useAgents) {
      retrieval = await tb.span('retrieval', () => retrieve(biz, text, { k: 3 }))
      tb.set({ retrieval: { ids: retrieval.passages.map((p) => p.id), scores: retrieval.passages.map((p) => p.score), grounded: retrieval.grounded, ms: retrieval.ms } })
    }
    let lastCitations: string[] = []
    let lastEstimated = false
    let lastTool: 'get_hours' | null = null
    const agentsActive = useAgents && retrieval !== null && retrieval.grounded
    const agentResponder = (tier: 'primary' | 'small'): Responder => ({
      name: `response-agent:${tier}`,
      respond: async ({ text: t, shortContext, signal }) => {
        const out = await runResponseAgent(this.llm, { business: biz.name, question: t, passages: retrieval!.passages, tier, shortContext, signal, hours: biz.locations })
        lastCitations = out.citations
        lastEstimated = out.usage.estimated
        lastTool = out.tool ?? null
        if (out.tool) return { text: out.text, ttftMs: out.ttftMs, model: out.model, payload: engineReplyNow }
        return { text: out.text, tokens: { prompt: out.usage.prompt, completion: out.usage.completion }, ttftMs: out.ttftMs, model: out.model, payload: engineReplyNow }
      },
    })
    const primary = this.opts.primary ? this.opts.primary(engine) : agentsActive ? agentResponder('primary') : engine
    const fallback = this.opts.fallback ? this.opts.fallback(engine) : agentsActive ? agentResponder('small') : engine
    const spanName = agentsActive || this.opts.primary || this.config.primaryModel !== 'rule-engine' ? 'llm' : 'engine'
    const ladder: LadderResult = await tb.span(spanName, () =>
      respondWithinBudget(callId, s.business, text, {
        config: agentsActive ? { ...this.config, primaryModel: this.llm.primaryModel, fallbackModel: this.llm.smallModel } : this.config,
        primary,
        fallback,
        cache: this.cache,
        tokens: this.tokens,
        cacheable: agentsActive,
        writeCache: false,
        elapsedBeforeMs: sttMs,
      }),
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

    // 5) Engine state + side-effect tools (deadline stays armed across progress updates)
    let reply = (ladder.payload as EngineReply | undefined) ?? null
    if (!reply && ladder.step === 'cache' && engineReplyNow) reply = engineReplyNow
    let text_ = ladder.text
    // Rule-engine hours reply reads the whole week; when the caller named a day or one practice,
    // answer just that from config with the get_hours tool (same data, shorter, more natural on a call).
    if (decision.route === 'rule' && reply?.intent === 'hours' && !ladder.fallback) {
      const h = answerHoursQuestion(biz.locations, text)
      if (h && (h.days.length > 0 || h.locations.length < biz.locations.length)) {
        text_ = h.text
        lastTool = 'get_hours'
        lastCitations = h.citations
      }
    }
    let handoff = ladder.handoff || reply?.escalate === true
    let outcome = reply ? (reply.outcome ?? null) : ladder.handoff ? 'transferred' : null
    const toolResults: Array<{ tool: string; ok: boolean; result?: string }> = []
    for (const t of reply?.toolCalls ?? []) {
      const bad = validateToolCall(t.tool, t.args ?? {})
      toolResults.push({ tool: t.tool, ok: bad === null, result: bad ? `schema_error: ${bad}` : String(t.result).slice(0, 80) })
    }
    if (lastTool) toolResults.push({ tool: lastTool, ok: true, result: lastCitations.join(',') })
    if (reply?.createTicket && !ladder.handoff) {
      const args = { ...reply.createTicket } as Record<string, unknown>
      const bad = validateToolCall('create_ticket', args)
      const run: ToolRunResult = bad
        ? { tool: 'create_ticket', ok: false, error: `schema_error: ${bad}`, progress: [], ms: 0 }
        : await tb.span('tool', () => runTool('create_ticket', this.opts.tools?.create_ticket ?? localTicketTool, args, { timeoutMs: this.opts.toolTimeoutMs ?? Number(process.env.TOOL_TIMEOUT_MS || 2000) }), { tool: 'create_ticket' })
      if (!run.ok) {
        const span = tb.record.spans[tb.record.spans.length - 1]
        if (span?.name === 'tool') Object.assign(span, { ok: false, error: run.error })
        if (!tb.record.error) tb.record.error = `tool: ${run.error}`
      }
      toolResults.push({ tool: 'create_ticket', ok: run.ok, result: run.ok ? String(run.result).slice(0, 80) : run.error })
      if (!run.ok) {
        // Never claim the request was sent when the tool failed -> apologise + hand off
        text_ = TOOL_FAILURE_TEXT
        handoff = true
        outcome = 'transferred'
        this.logDecision({ ...decision, ts: new Date().toISOString(), route: 'human', reason: `tool_failure:create_ticket:${run.error}` })
      }
    }

    // 6) Guard before TTS
    const fromModel = agentsActive && (ladder.step === 'primary' || ladder.step === 'smaller_model' || ladder.step === 'cache')
    // get_hours answers come from config: ground them in the full hours passages, not just the retrieved ones
    const cited = lastTool ? buildPassages(biz).filter((p) => lastCitations.includes(p.id)) : (retrieval?.passages.filter((p) => lastCitations.includes(p.id)) ?? [])
    const guard = guardReply({
      text: text_,
      source: fromModel ? 'llm' : 'engine',
      grounding: fromModel ? (cited.length ? cited : (retrieval?.passages ?? [])).map((p) => p.text) : engineGrounding(),
      allowedContacts,
      hours: fromModel ? biz.locations : undefined,
      callerText: fromModel ? text : undefined,
      maxChars: this.opts.guardMaxChars,
    })
    let citations = fromModel ? (ladder.step === 'cache' ? (retrieval?.passages.slice(0, 1).map((p) => p.id) ?? []) : lastCitations) : []
    if (guard.blocked) {
      // Model said something not in its passages -> deterministic engine answer instead
      text_ = engineReplyNow?.text ?? SAFE_LINE
      citations = []
    } else {
      text_ = guard.text
      if (fromModel && agentsActive && ladder.step !== 'cache' && !ladder.fallback) void this.cache.set(this.cache.key(text, s.business, this.config.policyVersion), text_)
    }

    let failed = false
    if (reply) {
      failed = isFailedClarification(stepBefore, reply, s.booking)
      s.booking = { ...s.booking, ...reply.bookingUpdates }
      s.step = reply.nextStep
    }
    if (handoff && (ladder.handoff || outcome === 'transferred')) s.step = 'escalated'
    this.clarifications.record(callId, failed)

    const model = ladder.model
    const cost = turnCostUsd(this.prices, { model, tokens: ladder.tokens, ttsChars: text_.length }).llm
    this.ledger.addTurn(callId, { tokens: ladder.tokens, costUsd: cost, tokenCapHit: ladder.tokenCapHit, smallModel: ladder.step === 'smaller_model' })

    tb.set({
      step_after: s.step,
      outcome,
      intent: reply?.intent ?? intent,
      failed_clarification: failed,
      handoff,
      fallback: ladder.fallback ? { ...ladder.fallback } : null,
      model,
      tokens: ladder.tokens,
      tokens_estimated: ladder.tokens ? lastEstimated : undefined,
      token_cap_hit: ladder.tokenCapHit,
      cost_usd: cost,
      cache_hit: ladder.cacheHit,
      llm_ttft_ms: ladder.ttftMs,
      reply_chars: text_.length,
      agent_path: agentsActive ? 'multi_agent' : 'engine',
      citations,
      guard: slimGuard(guard),
      tool_calls: toolResults,
    })
    return finishTurn({
      text: text_,
      route: handoff && ladder.handoff ? 'human' : decision.route,
      outcome,
      handoff,
      reply,
      citations,
      guard,
      costUsd: cost,
      cacheHit: ladder.cacheHit,
    })
  }
}

export const TOOL_FAILURE_TEXT =
  "I'm sorry, I couldn't send that to the team just now. I'll pass you to a member of the team so they can sort it out for you."

const slimGuard = (g: GuardResult) => ({ ok: g.ok, blocked: g.blocked, violations: g.violations })

