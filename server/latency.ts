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
import type { FallbackReason } from './router.ts'

export interface LatencyConfig {
  budgetMs: number
  headroomMs: number
  maxTokensPerCall: number
  fallbackTimeoutMs: number
  primaryModel: string
  fallbackModel: string
  cacheTtlMs: number
  policyVersion: string
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
    maxTokensPerCall: int(env.MAX_TOKENS_PER_CALL, 6000),
    fallbackTimeoutMs: int(env.FALLBACK_TIMEOUT_MS, 1500),
    primaryModel: env.LLM_PRIMARY_MODEL || 'rule-engine',
    fallbackModel: env.LLM_FALLBACK_MODEL || 'rule-engine',
    cacheTtlMs: int(env.ANSWER_CACHE_TTL_MS, 600_000),
    policyVersion: env.POLICY_VERSION || 'v1',
  }
}

export const FILLER_TEXT = 'One moment, please.'
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
}
export interface Responder {
  name: string
  respond(input: ResponderInput): Promise<ResponderOutput>
}

export const normalizeQuestion = (text: string): string =>
  text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim()

/** In-memory TTL cache. TODO: optional Redis backend if multi-instance is ever needed. */
export class AnswerCache {
  private store = new Map<string, { value: string; expires: number }>()
  private readonly ttlMs: number
  private readonly clock: () => number
  constructor(ttlMs: number, clock: () => number = Date.now) {
    this.ttlMs = ttlMs
    this.clock = clock
  }
  key(text: string, business: string, policyVersion: string): string {
    return `${business}|${policyVersion}|${normalizeQuestion(text)}`
  }
  get(key: string): string | null {
    const hit = this.store.get(key)
    if (!hit) return null
    if (hit.expires < this.clock()) {
      this.store.delete(key)
      return null
    }
    return hit.value
  }
  set(key: string, value: string): void {
    this.store.set(key, { value, expires: this.clock() + this.ttlMs })
  }
}

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
  cache: AnswerCache
  tokens: TokenBudget
  clock?: () => number
}

export async function respondWithinBudget(callId: string, business: string, text: string, deps: LadderDeps): Promise<LadderResult> {
  const clock = deps.clock ?? (() => performance.now())
  const t0 = clock()
  const { config, cache, tokens } = deps
  const cacheKey = cache.key(text, business, config.policyVersion)
  const since = () => Math.round(clock() - t0)

  const finish = (
    out: ResponderOutput,
    model: string,
    step: LadderStep,
    fallback: LadderResult['fallback'],
    filler?: number,
  ): LadderResult => {
    if (out.tokens) tokens.add(callId, out.tokens.prompt + out.tokens.completion)
    if (step === 'primary' || step === 'smaller_model') cache.set(cacheKey, out.text)
    return {
      text: out.text,
      firstAudioText: filler !== undefined ? FILLER_TEXT : out.text,
      firstAudioAtMs: filler ?? since(),
      model,
      step,
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
  })

  // Token cap
  if (tokens.wouldExceed(callId, estimateTokens(text))) {
    if (tokens.hit(callId) >= 2) return handoff('token_cap')
    const fb = await raceTimeout(deps.fallback, { text, shortContext: true }, config.fallbackTimeoutMs)
    if (fb.ok) return finish(fb.out, config.fallbackModel, 'smaller_model', { reason: 'token_cap', step: 'smaller_model' })
    return handoff('token_cap')
  }

  const primary = await raceTimeout(deps.primary, { text }, Math.max(0, config.budgetMs - config.headroomMs))
  if (primary.ok) return finish(primary.out, config.primaryModel, 'primary', null)

  const reason: FallbackReason = primary.error ? 'llm_error' : 'budget_exceeded'
  const cached = cache.get(cacheKey)
  if (cached) return finish({ text: cached }, 'cache', 'cache', { reason, step: 'cache' })

  // Filler is spoken now (at the deadline) so first audio stays inside the budget
  const fillerAt = since()
  const fb = await raceTimeout(deps.fallback, { text }, config.fallbackTimeoutMs)
  if (fb.ok) return finish(fb.out, config.fallbackModel, 'smaller_model', { reason, step: 'smaller_model' }, fillerAt)
  return handoff(fb.error ? 'llm_error' : 'llm_timeout', fillerAt)
}
