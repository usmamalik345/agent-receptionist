/**
 * Latency budget, per-call token cap and fallback ladder.
 * When the primary responder misses (budget - headroom) or errors:
 *   (a) cached answer (normalized question + business + policy version, TTL)
 *   (b) smaller / faster responder; a filler line is spoken at the deadline so
 *       first audio still lands inside the budget
 *   (c) filler + human hand-off if the smaller responder also fails
 * Token cap: first breach -> smaller responder with shorter context; second -> hand-off.
 * Today the primary responder is the deterministic rule engine (no LLM in this repo),
 * so the ladder only fires when a slower responder (e.g. a future LLM) is plugged in.
 */
import { LruCache, type ResponseCache } from './cacheCore.ts'
import type { FallbackReason } from './router.ts'
export { normalizeQuestion } from './cacheCore.ts'

export interface LatencyConfig {
  budgetMs: number
  headroomMs: number
  maxTokensPerCall: number
  fallbackTimeoutMs: number
  primaryModel: string
  fallbackModel: string
  cacheTtlMs: number
  policyVersion: string
  /** Tokens reserved per model answer in the pre-flight cap check (real Groq max per answer: 544, 24 Nov 2026) */
  tokenReservePerAnswer: number
  /** Caller silence (ms after our last audio) before we re-prompt; a second miss hands off */
  callerSilenceMs: number
}

const int = (v: string | undefined, d: number): number => {
  if (v === undefined || v === '') return d
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : d
}

export function loadLatencyConfig(env: Record<string, string | undefined> = process.env): LatencyConfig {
  return {
    budgetMs: int(env.LATENCY_BUDGET_FIRST_AUDIO_MS, 800),
    headroomMs: int(env.LATENCY_HEADROOM_MS, 150),
    // 2500 = real data: gpt-oss-20b on Groq used 304 tokens per model answer on average and 544 at most
    // (replay n=25, probe n=90, 24 Nov 2026), so 2500 allows >= 4 worst-case / ~8 typical model answers per call.
    maxTokensPerCall: int(env.MAX_TOKENS_PER_CALL, 2500),
    tokenReservePerAnswer: int(env.TOKEN_RESERVE_PER_ANSWER, 550),
    // Design default, not measured: 7 s of caller silence -> "Are you still there?"; second time -> hand-off.
    callerSilenceMs: int(env.CALLER_SILENCE_MS, 7000),
    fallbackTimeoutMs: int(env.FALLBACK_TIMEOUT_MS, 1500),
    primaryModel: env.LLM_PRIMARY_MODEL || 'rule-engine',
    fallbackModel: env.LLM_FALLBACK_MODEL || 'rule-engine',
    cacheTtlMs: int(env.ANSWER_CACHE_TTL_MS, 600_000),
    policyVersion: env.POLICY_VERSION || 'v1',
  }
}

export const FILLER_TEXT = 'One moment, please.'
export const SILENCE_REPROMPT_TEXT = "Are you still there? Take your time."
export const SILENCE_HANDOFF_TEXT = "I can't hear anything, so I'll ask the team to call you back. Thanks for calling."

export type SilenceAction = { action: 'wait' } | { action: 'reprompt'; text: string } | { action: 'handoff'; text: string }

/** Caller-silence budget: under budget -> wait; first breach -> re-prompt; second consecutive breach -> hand-off. */
export class SilenceMonitor {
  private misses = new Map<string, number>()
  private readonly budgetMs: number
  constructor(budgetMs: number) {
    this.budgetMs = budgetMs
  }
  check(callId: string, silentMs: number): SilenceAction {
    if (silentMs < this.budgetMs) return { action: 'wait' }
    const n = (this.misses.get(callId) ?? 0) + 1
    this.misses.set(callId, n)
    return n >= 2 ? { action: 'handoff', text: SILENCE_HANDOFF_TEXT } : { action: 'reprompt', text: SILENCE_REPROMPT_TEXT }
  }
  /** The caller spoke: reset the count */
  reset(callId: string): void {
    this.misses.delete(callId)
  }
}
export const HANDOFF_AFTER_FILLER =
  "I'm going to pass you to a member of the team so you're not kept waiting. They'll be with you shortly."

export interface ResponderInput {
  text: string
  /** true after the token cap - use a shorter context */
  shortContext?: boolean
  signal?: AbortSignal
}
export interface ResponderOutput {
  text: string
  /** Only set when the backend reports real usage */
  tokens?: { prompt: number; completion: number }
  ttftMs?: number
  /** opaque payload passed through (e.g. engine reply) */
  payload?: unknown
  /** Model that produced the text (LLM responders) */
  model?: string
}
export interface Responder {
  name: string
  respond(input: ResponderInput): Promise<ResponderOutput>
}

/** Back-compat name: the in-memory LRU response cache (see server/cache.ts). */
export const AnswerCache = LruCache
export type AnswerCache = LruCache

export class TokenBudget {
  private used = new Map<string, number>()
  private capHits = new Map<string, number>()
  private readonly max: number
  constructor(max: number) {
    this.max = max
  }
  usedBy(callId: string): number {
    return this.used.get(callId) ?? 0
  }
  add(callId: string, n: number): void {
    this.used.set(callId, this.usedBy(callId) + Math.max(0, n))
  }
  wouldExceed(callId: string, estimate: number): boolean {
    return this.usedBy(callId) + estimate > this.max
  }
  hit(callId: string): number {
    const n = (this.capHits.get(callId) ?? 0) + 1
    this.capHits.set(callId, n)
    return n
  }
}

/** Rough pre-flight estimate (~4 chars/token) used ONLY for the cap check, never reported as usage. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4)

export type LadderStep = 'primary' | 'cache' | 'smaller_model' | 'human'

export interface LadderResult {
  text: string
  /** What is spoken first (filler when we fell back past the deadline) */
  firstAudioText: string
  /** ms after turn start when first audio could be sent */
  firstAudioAtMs: number
  model: string
  step: LadderStep
  handoff: boolean
  fallback: { reason: FallbackReason; step: LadderStep } | null
  tokens: { prompt: number; completion: number } | null
  ttftMs: number | null
  payload?: unknown
  /** Served from the response cache before calling any model */
  cacheHit: boolean
  /** The per-call token cap was hit on this turn */
  tokenCapHit: boolean
}

type Race = { ok: true; out: ResponderOutput } | { ok: false; error?: string }

async function raceTimeout(r: Responder, input: ResponderInput, timeoutMs: number): Promise<Race> {
  const ac = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<Race>((resolve) => {
    timer = setTimeout(() => {
      ac.abort()
      resolve({ ok: false })
    }, timeoutMs)
  })
  const run = r
    .respond({ ...input, signal: ac.signal })
    .then((out): Race => ({ ok: true, out }))
    .catch((e): Race => ({ ok: false, error: e instanceof Error ? e.message : String(e) }))
  try {
    return await Promise.race([run, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export interface LadderDeps {
  config: LatencyConfig
  primary: Responder
  fallback: Responder
  cache: ResponseCache
  tokens: TokenBudget
  clock?: () => number
  /** Answer is stateless (FAQ/retrieval) -> may be looked up first and cached. Default false. */
  cacheable?: boolean
  /** Write primary/smaller-model answers into the cache (default: same as cacheable).
   *  The runtime sets false and writes only after the guard passed. */
  writeCache?: boolean
  /** Time already spent before the agent got the transcript (STT/endpointing). Shrinks the deadline. */
  elapsedBeforeMs?: number
}

export async function respondWithinBudget(callId: string, business: string, text: string, deps: LadderDeps): Promise<LadderResult> {
  const clock = deps.clock ?? (() => performance.now())
  const t0 = clock()
  const { config, cache, tokens } = deps
  const cacheable = deps.cacheable ?? false
  const writeCache = deps.writeCache ?? cacheable
  const cacheKey = cache.key(text, business, config.policyVersion)
  const since = () => Math.round(clock() - t0)
  const primaryDeadline = Math.max(0, config.budgetMs - config.headroomMs - (deps.elapsedBeforeMs ?? 0))
  let tokenCapHit = false

  const finish = (
    out: ResponderOutput,
    model: string,
    step: LadderStep,
    fallback: LadderResult['fallback'],
    filler?: number,
  ): LadderResult => {
    if (out.tokens) tokens.add(callId, out.tokens.prompt + out.tokens.completion)
    if (writeCache && (step === 'primary' || step === 'smaller_model')) void cache.set(cacheKey, out.text)
    return {
      text: out.text,
      firstAudioText: filler !== undefined ? FILLER_TEXT : out.text,
      firstAudioAtMs: filler ?? since(),
      model: out.model ?? model,
      step,
      cacheHit: step === 'cache' && fallback === null,
      tokenCapHit,
      handoff: false,
      fallback,
      tokens: out.tokens ?? null,
      ttftMs: out.ttftMs ?? null,
      payload: out.payload,
    }
  }
  const handoff = (reason: FallbackReason, fillerAt?: number): LadderResult => ({
    text: `${FILLER_TEXT} ${HANDOFF_AFTER_FILLER}`,
    firstAudioText: FILLER_TEXT,
    firstAudioAtMs: fillerAt ?? since(),
    model: 'none',
    step: 'human',
    handoff: true,
    fallback: { reason, step: 'human' },
    tokens: null,
    ttftMs: null,
    cacheHit: false,
    tokenCapHit,
  })

  // (a) same question already answered (and guarded) for this business + policy version
  if (cacheable) {
    const hit = await cache.get(cacheKey)
    if (hit !== null) return finish({ text: hit }, 'cache', 'cache', null)
  }

  // Token cap
  if (tokens.wouldExceed(callId, estimateTokens(text) + (config.tokenReservePerAnswer ?? 0))) {
    tokenCapHit = true
    if (tokens.hit(callId) >= 2) return handoff('token_cap')
    const fb = await raceTimeout(deps.fallback, { text, shortContext: true }, config.fallbackTimeoutMs)
    if (fb.ok) return finish(fb.out, config.fallbackModel, 'smaller_model', { reason: 'token_cap', step: 'smaller_model' })
    return handoff('token_cap')
  }

  const primary = await raceTimeout(deps.primary, { text }, primaryDeadline)
  if (primary.ok) return finish(primary.out, config.primaryModel, 'primary', null)

  const reason: FallbackReason = primary.error ? 'llm_error' : 'budget_exceeded'
  // Fallback lookup reads the cache even for non-cacheable turns (back-compat), but those are never written.
  const cached = await cache.get(cacheKey)
  if (cached !== null) return finish({ text: cached }, 'cache', 'cache', { reason, step: 'cache' })

  // Filler is spoken now (at the deadline) so first audio stays inside the budget
  const fillerAt = since()
  const fb = await raceTimeout(deps.fallback, { text }, config.fallbackTimeoutMs)
  if (fb.ok) return finish(fb.out, config.fallbackModel, 'smaller_model', { reason, step: 'smaller_model' }, fillerAt)
  return handoff(fb.error ? 'llm_error' : 'llm_timeout', fillerAt)
}
