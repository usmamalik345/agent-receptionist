/**
 * Per-call tracing. One trace_id per call/session, one JSONL record per turn with
 * spans (router, engine/llm, tts, tool, cache, fallback...), time-to-first-audio,
 * tokens (only when a real LLM reports them - never estimated), tool calls,
 * route and errors. Appends to logs/traces.jsonl (override with TRACE_FILE).
 * Caller text is NOT stored unless TRACE_STORE_TEXT=1, and then digits are masked.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { RouterDecision, Route } from './router.ts'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
export const LOG_DIR = path.join(ROOT, 'logs')
export const DEFAULT_TRACE_FILE = path.join(LOG_DIR, 'traces.jsonl')
export const ROUTER_DECISIONS_FILE = path.join(LOG_DIR, 'router_decisions.jsonl')

export type TraceSource = 'server' | 'browser' | 'eval' | 'replay'

export interface Span {
  name: string
  start_ms: number
  duration_ms: number
  ok: boolean
  attrs?: Record<string, unknown>
  error?: string
}

export interface TokenUsage {
  prompt: number
  completion: number
}

export interface TurnTrace {
  type: 'turn'
  trace_id: string
  call_id: string
  turn_id: number
  ts: string
  source: TraceSource
  business: string | null
  channel: string | null
  route: Route | null
  router: Pick<RouterDecision, 'reason' | 'confidence' | 'matched_rule' | 'intent' | 'latency_ms'> | null
  spans: Span[]
  stt_ms: number | null
  endpointing_ms: number | null
  llm_ttft_ms: number | null
  tts_ttfb_ms: number | null
  /** End of user speech -> first bot audio frame (browser; null if not measured) */
  ttfa_ms: number | null
  /** Server-side: turn start -> text for first audio ready (excludes TTS) */
  first_audio_ready_ms: number | null
  tokens: TokenUsage | null
  tts_chars: number | null
  tool_calls: Array<{ tool: string; ok: boolean; result?: string }>
  intent: string | null
  outcome: string | null
  step_before: string | null
  step_after: string | null
  failed_clarification: boolean
  handoff: boolean
  fallback: { reason: string; step: string } | null
  model: string | null
  reply_chars: number | null
  user_text?: string
  error: string | null
}

export type Sink = (record: object) => void

export function appendJsonl(file: string, record: object): void {
  mkdirSync(path.dirname(file), { recursive: true })
  appendFileSync(file, JSON.stringify(record) + '\n', 'utf8')
}

export const jsonlSink = (file: string): Sink => (record) => appendJsonl(file, record)

export const memorySink = (store: object[]): Sink => (record) => {
  store.push(record)
}

export function defaultTraceSink(env: NodeJS.ProcessEnv = process.env): Sink {
  return jsonlSink(env.TRACE_FILE || DEFAULT_TRACE_FILE)
}

/** Router decisions go to stdout AND logs/router_decisions.jsonl. */
export function logRouterDecision(decision: RouterDecision, sink: Sink = jsonlSink(ROUTER_DECISIONS_FILE), stdout = true): void {
  if (stdout) console.log(JSON.stringify(decision))
  sink(decision)
}

export const redactText = (text: string, max = 160): string => text.replace(/\d/g, '#').slice(0, max)
export const newTraceId = (): string => randomUUID()
const now = (): number => performance.now()
const round = (n: number): number => Math.round(n * 10) / 10

export class TurnBuilder {
  readonly record: TurnTrace
  private readonly t0: number
  private ended = false
  private readonly clock: () => number
  private readonly sink: Sink

  constructor(base: Omit<TurnTrace, 'type' | 'ts' | 'spans'>, sink: Sink, clock: () => number = now) {
    this.clock = clock
    this.sink = sink
    this.t0 = clock()
    this.record = { type: 'turn', ts: new Date().toISOString(), spans: [], ...base }
  }

  /** ms since the turn started (end of user speech / transcript received). */
  elapsed(): number {
    return round(this.clock() - this.t0)
  }

  addSpan(span: Span): void {
    this.record.spans.push(span)
    if (!span.ok && span.error && !this.record.error) this.record.error = `${span.name}: ${span.error}`
  }

  async span<T>(name: string, fn: () => Promise<T> | T, attrs?: Record<string, unknown>): Promise<T> {
    const start = this.clock()
    const base = () => ({ name, start_ms: round(start - this.t0), duration_ms: round(this.clock() - start), attrs })
    try {
      const out = await fn()
      this.addSpan({ ...base(), ok: true })
      return out
    } catch (e) {
      this.addSpan({ ...base(), ok: false, error: e instanceof Error ? e.message : String(e) })
      throw e
    }
  }

  set(fields: Partial<TurnTrace>): this {
    Object.assign(this.record, fields)
    return this
  }

  /** Mark first audio (first TTS byte / filler line) relative to turn start. */
  markFirstAudio(): void {
    if (this.record.ttfa_ms == null) this.record.ttfa_ms = this.elapsed()
  }

  end(): TurnTrace {
    if (!this.ended) {
      this.ended = true
      this.sink(this.record)
    }
    return this.record
  }
}

export interface CallTraceOptions {
  source: TraceSource
  business?: string | null
  channel?: string | null
  sink?: Sink
  clock?: () => number
}

const EMPTY_TURN = {
  route: null, router: null, stt_ms: null, endpointing_ms: null, llm_ttft_ms: null, tts_ttfb_ms: null,
  ttfa_ms: null, first_audio_ready_ms: null, tokens: null, tts_chars: null, intent: null, outcome: null,
  step_before: null, step_after: null, failed_clarification: false, handoff: false, fallback: null,
  model: null, reply_chars: null, error: null,
} as const

export class CallTrace {
  readonly traceId: string
  readonly callId: string
  private turn = 0
  private readonly opts: CallTraceOptions
  constructor(callId: string, opts: CallTraceOptions) {
    this.opts = opts
    this.callId = callId
    this.traceId = newTraceId()
  }

  get turns(): number {
    return this.turn
  }

  startTurn(extra: Partial<TurnTrace> = {}): TurnBuilder {
    this.turn += 1
    return new TurnBuilder(
      {
        ...EMPTY_TURN,
        trace_id: this.traceId,
        call_id: this.callId,
        turn_id: this.turn,
        source: this.opts.source,
        business: this.opts.business ?? null,
        channel: this.opts.channel ?? null,
        tool_calls: [],
        ...extra,
      },
      this.opts.sink ?? defaultTraceSink(),
      this.opts.clock,
    )
  }
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 3_600_000 ? round(v) : null
const str = (v: unknown, max = 120): string | null => (typeof v === 'string' && v ? v.slice(0, max) : null)

/**
 * Whitelist a browser-posted turn (POST /api/trace). Unknown fields are dropped,
 * numbers clamped, strings capped; caller text is never accepted from the browser.
 */
export function sanitizeBrowserTurn(body: unknown): { turn: TurnTrace; decision: RouterDecision | null } | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  const callId = str(b.call_id, 80)
  if (!callId) return null
  const route = ['rule', 'tool', 'retrieval', 'human'].includes(String(b.route)) ? (b.route as Route) : null
  const rd = (b.router && typeof b.router === 'object' ? b.router : null) as Record<string, unknown> | null
  const router = rd
    ? {
        reason: str(rd.reason) ?? '',
        confidence: Number(rd.confidence) || 0,
        matched_rule: str(rd.matched_rule),
        intent: (str(rd.intent, 40) ?? 'unknown') as RouterDecision['intent'],
        latency_ms: num(rd.latency_ms) ?? 0,
      }
    : null
  const list = (v: unknown) => (Array.isArray(v) ? (v as Record<string, unknown>[]).slice(0, 20) : [])
  const turn: TurnTrace = {
    ...EMPTY_TURN,
    type: 'turn',
    trace_id: str(b.trace_id, 80) ?? callId,
    call_id: callId,
    turn_id: Math.max(0, Math.floor(Number(b.turn_id) || 0)),
    ts: new Date().toISOString(),
    source: 'browser',
    business: str(b.business, 40),
    channel: str(b.channel, 20),
    route,
    router,
    spans: list(b.spans).map((s) => ({
      name: str(s.name, 40) ?? 'span',
      start_ms: num(s.start_ms) ?? 0,
      duration_ms: num(s.duration_ms) ?? 0,
      ok: s.ok !== false,
      ...(str(s.error, 200) ? { error: str(s.error, 200)! } : {}),
    })),
    stt_ms: num(b.stt_ms),
    endpointing_ms: num(b.endpointing_ms),
    llm_ttft_ms: num(b.llm_ttft_ms),
    tts_ttfb_ms: num(b.tts_ttfb_ms),
    ttfa_ms: num(b.ttfa_ms),
    first_audio_ready_ms: num(b.first_audio_ready_ms),
    tts_chars: num(b.tts_chars),
    tool_calls: list(b.tool_calls).map((t) => ({ tool: str(t.tool, 60) ?? '?', ok: t.ok !== false })),
    intent: str(b.intent, 40),
    outcome: str(b.outcome, 40),
    step_before: str(b.step_before, 40),
    step_after: str(b.step_after, 40),
    failed_clarification: b.failed_clarification === true,
    handoff: b.handoff === true,
    model: str(b.model, 60),
    reply_chars: num(b.reply_chars),
    error: str(b.error, 200),
  }
  const decision: RouterDecision | null =
    router && route
      ? { type: 'router_decision', ts: turn.ts, call_id: callId, turn_id: turn.turn_id, route, ...router }
      : null
  return { turn, decision }
}
