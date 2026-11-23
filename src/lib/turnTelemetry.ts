/**
 * Browser per-turn telemetry for the live demo (opt-in: VITE_TRACE=1, otherwise a no-op).
 * Router runs observe-only here (decision logged, reply unchanged). One record per turn is
 * POSTed to /api/trace -> logs/traces.jsonl. Caller text is never sent.
 */
import { buildRetrievalCorpus, ClarificationTracker, isFailedClarification, routeTurn } from '../../server/router.ts'
import { getActiveBusiness } from './businessRuntime'
import type { ConversationStep, Intent, Outcome } from './types'

const ENABLED = import.meta.env.VITE_TRACE === '1'
const FLUSH_WITHOUT_AUDIO_MS = 4000

type Pending = Record<string, unknown> & { started_at: number; ttfa_ms: number | null; tts_ttfb_ms: number | null }

const clarifications = new ClarificationTracker()
const turnCounters = new Map<string, number>()
let lastSpeechEndAt: number | null = null
let ttsRequestedAt: number | null = null
let pending: Pending | null = null
let flushTimer: ReturnType<typeof setTimeout> | null = null

const now = () => performance.now()
const r1 = (n: number) => Math.round(n * 10) / 10

/** Call on each STT result; the last one before submit = end of user speech. */
export function markUserSpeechEnd(at: number = now()): void {
  if (ENABLED) lastSpeechEndAt = at
}

/** Call right before handing the reply to TTS. */
export function markTtsRequested(): void {
  if (ENABLED && pending) ttsRequestedAt = now()
}

/** Called by speech.ts when the first bot audio actually starts playing. */
export function markFirstAudio(): void {
  if (!ENABLED || !pending || pending.ttfa_ms != null) return
  const t = now()
  pending.ttfa_ms = r1(t - pending.started_at)
  if (ttsRequestedAt != null) pending.tts_ttfb_ms = r1(t - ttsRequestedAt)
  flush()
}

export function recordEngineTurn(input: {
  callId: string
  channel: string
  text: string
  stepBefore: ConversationStep
  bookingBefore?: object
  engineStart: number
  engineEnd: number
  reply: {
    nextStep: ConversationStep
    bookingUpdates: object
    intent?: Intent
    outcome?: Outcome
    escalate?: boolean
    toolCalls: Array<{ tool: string }>
    text: string
  }
}): void {
  if (!ENABLED) return
  if (pending) flush()
  const biz = getActiveBusiness()
  const turnId = (turnCounters.get(input.callId) ?? 0) + 1
  turnCounters.set(input.callId, turnId)
  const d = routeTurn(input.text, {
    callId: input.callId,
    turnId,
    step: input.stepBefore,
    industry: biz.industry,
    corpus: buildRetrievalCorpus(biz),
    failedClarifications: clarifications.get(input.callId),
  })
  const failed = isFailedClarification(input.stepBefore, input.reply, input.bookingBefore)
  clarifications.record(input.callId, failed)
  const hadSpeech = lastSpeechEndAt != null
  const startedAt = lastSpeechEndAt ?? input.engineStart
  lastSpeechEndAt = null
  ttsRequestedAt = null
  pending = {
    call_id: input.callId,
    turn_id: turnId,
    business: biz.slug,
    channel: input.channel,
    started_at: startedAt,
    route: d.route,
    router: { reason: d.reason, confidence: d.confidence, matched_rule: d.matched_rule, intent: d.intent, latency_ms: d.latency_ms },
    intent: input.reply.intent ?? d.intent,
    outcome: input.reply.outcome ?? null,
    step_before: input.stepBefore,
    step_after: input.reply.nextStep,
    failed_clarification: failed,
    handoff: input.reply.escalate === true,
    tool_calls: input.reply.toolCalls.map((t) => ({ tool: t.tool, ok: true })),
    reply_chars: input.reply.text.length,
    spans: [{ name: 'engine', start_ms: r1(input.engineStart - startedAt), duration_ms: r1(input.engineEnd - input.engineStart), ok: true }],
    // Voice: silence wait between last STT result and submit (MIC_SILENCE_MS in DashboardPage)
    endpointing_ms: hadSpeech ? r1(input.engineStart - startedAt) : null,
    model: 'rule-engine',
    ttfa_ms: null,
    tts_ttfb_ms: null,
  }
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = setTimeout(flush, FLUSH_WITHOUT_AUDIO_MS)
}

function flush(): void {
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = null
  const turn = pending
  pending = null
  if (!turn) return
  const body: Record<string, unknown> = { ...turn }
  delete body.started_at
  void fetch('/api/trace', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    keepalive: true,
  }).catch(() => {
    /* tracing must never break the demo */
  })
}
