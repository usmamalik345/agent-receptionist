/**
 * Pluggable LLM client. Provider picked by env:
 *   LLM_PROVIDER=mock (default)   deterministic, offline, no key, $0
 *   LLM_PROVIDER=groq             Groq free tier (OpenAI-compatible endpoint)
 *   LLM_PROVIDER=gemini           Google AI Studio free tier (OpenAI-compatible endpoint)
 *   LLM_PROVIDER=openai-compatible  any OpenAI-style /chat/completions server, e.g. local Ollama
 * LLM_API_KEY, LLM_MODEL, LLM_SMALL_MODEL, LLM_BASE_URL, LLM_TIMEOUT_MS.
 * Keys are read from env only. Tests never make network calls (they inject `fetchImpl`).
 * A non-mock provider without a key (except local openai-compatible) falls back to mock
 * and says so in `client.note` - it never silently calls anything.
 */

export type LlmProvider = 'mock' | 'groq' | 'gemini' | 'openai-compatible'

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface LlmRequest {
  messages: LlmMessage[]
  /** 'primary' or 'small' (fallback / short-context model) */
  tier?: 'primary' | 'small'
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
}

export interface LlmUsage {
  prompt: number
  completion: number
  /** true when the provider did not report usage and we estimated (~4 chars/token) */
  estimated: boolean
}

export interface LlmResponse {
  text: string
  model: string
  provider: LlmProvider
  usage: LlmUsage
  /** ms from request start to first answer token (streaming); non-streaming: to full response */
  ttftMs: number
}

export interface LlmClient {
  provider: LlmProvider
  primaryModel: string
  smallModel: string
  /** Why this client was chosen (e.g. "no LLM_API_KEY -> mock") */
  note: string
  complete(req: LlmRequest): Promise<LlmResponse>
}

export const estimateTokenCount = (s: string): number => Math.ceil(s.length / 4)

const DEFAULTS: Record<Exclude<LlmProvider, 'mock'>, { baseUrl: string; model: string; small: string }> = {
  // https://console.groq.com/docs/models (checked 24 Nov 2026: llama-3.x moved to enterprise; gpt-oss is self-serve)
  groq: { baseUrl: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-20b', small: 'openai/gpt-oss-20b' },
  // https://ai.google.dev/gemini-api/docs/openai
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash-lite', small: 'gemini-2.5-flash-lite' },
  // e.g. Ollama: http://localhost:11434/v1 (free, local)
  'openai-compatible': { baseUrl: 'http://localhost:11434/v1', model: 'llama3.2:3b', small: 'llama3.2:1b' },
}

/**
 * Mock "LLM": deterministic and extractive. It answers ONLY with the first
 * passage in the prompt's CONTEXT block (lines like `[id] text`), and cites it.
 * No passages -> a fixed "I'll check with the team" line. Optional fixed latency.
 */
export function createMockClient(opts: { latencyMs?: number; model?: string; smallModel?: string; note?: string } = {}): LlmClient {
  const latency = opts.latencyMs ?? 0
  return {
    provider: 'mock',
    primaryModel: opts.model ?? 'mock-primary',
    smallModel: opts.smallModel ?? 'mock-small',
    note: opts.note ?? 'LLM_PROVIDER=mock (deterministic, offline)',
    async complete(req) {
      const t0 = performance.now()
      if (latency > 0) await abortableSleep(latency, req.signal)
      const prompt = req.messages.map((m) => m.content).join('\n')
      const last = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? ''
      const m = last.match(/^\[([^\]]+)\]\s*(.+)$/m)
      const text = m ? `${firstAnswer(m[2])} [${m[1]}]` : "I don't have that information to hand, so I'll ask the team to confirm it for you."
      const max = req.maxTokens ?? 200
      const clipped = estimateTokenCount(text) > max ? text.slice(0, max * 4) : text
      return {
        text: clipped,
        model: req.tier === 'small' ? (opts.smallModel ?? 'mock-small') : (opts.model ?? 'mock-primary'),
        provider: 'mock',
        usage: { prompt: estimateTokenCount(prompt), completion: estimateTokenCount(clipped), estimated: true },
        ttftMs: Math.round(performance.now() - t0),
      }
    },
  }
}

/** Passage text may be "Q: ... A: ..." - answer with the A part. */
function firstAnswer(passage: string): string {
  const a = passage.match(/\bA:\s*(.+)$/)
  return (a ? a[1] : passage).trim()
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'))
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      reject(new Error('aborted'))
    }, { once: true })
  })
}

type FetchResponse = {
  ok: boolean
  status: number
  headers?: { get(name: string): string | null }
  json(): Promise<unknown>
  text(): Promise<string>
  body?: AsyncIterable<Uint8Array> | null
}
type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<FetchResponse>

export interface LlmClientStats {
  requests: number
  http429: number
  errors: number
  /** retry-after (ms) from the last 429, 0 if none */
  lastRetryAfterMs: number
  promptTokens: number
  completionTokens: number
}

/** OpenAI-compatible clients also expose request stats (rate-limit handling, budgets). */
export interface RemoteLlmClient extends LlmClient {
  stats(): LlmClientStats
}

export const isReasoningModel = (model: string) => /gpt-oss/i.test(model)

/** Parse an SSE chat-completions stream: first content delta time, text, usage. */
export async function readSseStream(
  body: AsyncIterable<Uint8Array>,
  t0: number,
): Promise<{ text: string; firstTokenMs: number | null; usage: { prompt_tokens?: number; completion_tokens?: number } | null }> {
  const dec = new TextDecoder()
  let buf = ''
  let text = ''
  let first: number | null = null
  let usage: { prompt_tokens?: number; completion_tokens?: number } | null = null
  for await (const chunk of body) {
    buf += dec.decode(chunk, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') continue
      try {
        const j = JSON.parse(data) as {
          choices?: Array<{ delta?: { content?: string } }>
          usage?: { prompt_tokens?: number; completion_tokens?: number }
          x_groq?: { usage?: { prompt_tokens?: number; completion_tokens?: number } }
        }
        const d = j.choices?.[0]?.delta?.content
        if (d) {
          if (first === null) first = Math.round(performance.now() - t0)
          text += d
        }
        const u = j.usage ?? j.x_groq?.usage
        if (u && typeof u.prompt_tokens === 'number') usage = u
      } catch {
        /* ignore keep-alive / partial lines */
      }
    }
  }
  return { text, firstTokenMs: first, usage }
}

export function createOpenAiCompatibleClient(opts: {
  provider: Exclude<LlmProvider, 'mock'>
  baseUrl: string
  apiKey?: string
  model: string
  smallModel: string
  timeoutMs?: number
  fetchImpl?: FetchLike
  note?: string
  /** stream=true -> real time-to-first-token (default true) */
  stream?: boolean
  /** gpt-oss: reasoning effort (default 'low') */
  reasoningEffort?: string
  /** reasoning models spend completion tokens on hidden reasoning: floor for max_tokens */
  minCompletionTokens?: number
  /** hard cap on requests per process (free-tier protection); over it -> error, ladder falls back */
  maxRequests?: number
}): RemoteLlmClient {
  const doFetch: FetchLike = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
  const st: LlmClientStats = { requests: 0, http429: 0, errors: 0, lastRetryAfterMs: 0, promptTokens: 0, completionTokens: 0 }
  let blockedUntil = 0
  return {
    provider: opts.provider,
    primaryModel: opts.model,
    smallModel: opts.smallModel,
    note: opts.note ?? `LLM_PROVIDER=${opts.provider}`,
    stats: () => ({ ...st }),
    async complete(req) {
      const model = req.tier === 'small' ? opts.smallModel : opts.model
      // Respect a recent 429 retry-after without calling the API again (fail fast -> ladder fallback)
      if (Date.now() < blockedUntil) throw new Error('llm_http_429: local backoff (retry-after)')
      if (opts.maxRequests !== undefined && st.requests >= opts.maxRequests) throw new Error('llm_request_cap: LLM_MAX_REQUESTS reached')
      st.requests++
      const t0 = performance.now()
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 8000)
      req.signal?.addEventListener('abort', () => ac.abort(), { once: true })
      const stream = opts.stream ?? true
      try {
        const headers: Record<string, string> = { 'content-type': 'application/json' }
        if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`
        const reasoning = isReasoningModel(model)
        const maxTokens = Math.max(req.maxTokens ?? 200, reasoning ? (opts.minCompletionTokens ?? 400) : 0)
        const payload: Record<string, unknown> = { model, messages: req.messages, max_tokens: maxTokens, temperature: req.temperature ?? 0, stream }
        if (reasoning) {
          payload.reasoning_effort = opts.reasoningEffort ?? 'low'
          payload.include_reasoning = false
        }
        if (stream) payload.stream_options = { include_usage: true }
        const res = await doFetch(`${opts.baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: ac.signal,
        })
        if (!res.ok) {
          if (res.status === 429) {
            st.http429++
            const ra = Number(res.headers?.get('retry-after') ?? '')
            st.lastRetryAfterMs = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 120_000) : 10_000
            blockedUntil = Date.now() + st.lastRetryAfterMs
          }
          // Body is the provider's error JSON; never contains our key. Trimmed.
          throw new Error(`llm_http_${res.status}: ${(await res.text()).slice(0, 160)}`)
        }
        const prompt = req.messages.map((m) => m.content).join('\n')
        let text: string
        let firstMs: number
        let usage: { prompt_tokens?: number; completion_tokens?: number } | null | undefined
        if (stream && res.body) {
          const r = await readSseStream(res.body, t0)
          text = r.text.trim()
          firstMs = r.firstTokenMs ?? Math.round(performance.now() - t0)
          usage = r.usage
        } else {
          const body = (await res.json()) as {
            choices?: Array<{ message?: { content?: string } }>
            usage?: { prompt_tokens?: number; completion_tokens?: number }
          }
          text = String(body.choices?.[0]?.message?.content ?? '').trim()
          firstMs = Math.round(performance.now() - t0)
          usage = body.usage
        }
        if (!text) throw new Error('llm_empty: no content (reasoning used the whole token budget?)')
        const reported = typeof usage?.prompt_tokens === 'number' && typeof usage?.completion_tokens === 'number'
        const u = reported
          ? { prompt: usage!.prompt_tokens!, completion: usage!.completion_tokens!, estimated: false }
          : { prompt: estimateTokenCount(prompt), completion: estimateTokenCount(text), estimated: true }
        st.promptTokens += u.prompt
        st.completionTokens += u.completion
        return { text, model, provider: opts.provider, usage: u, ttftMs: firstMs }
      } catch (e) {
        st.errors++
        throw e
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

export function loadLlmClient(env: Record<string, string | undefined> = process.env, fetchImpl?: FetchLike): LlmClient {
  const provider = (env.LLM_PROVIDER || 'mock').toLowerCase() as LlmProvider
  const mockLatency = Number(env.MOCK_LLM_LATENCY_MS || 0) || 0
  if (provider === 'mock' || !(provider in DEFAULTS)) {
    return createMockClient({
      latencyMs: mockLatency,
      note: provider === 'mock' ? 'LLM_PROVIDER=mock (deterministic, offline)' : `unknown LLM_PROVIDER=${provider} -> mock`,
    })
  }
  const d = DEFAULTS[provider as Exclude<LlmProvider, 'mock'>]
  const apiKey = env.LLM_API_KEY || undefined
  if (!apiKey && provider !== 'openai-compatible') {
    return createMockClient({ latencyMs: mockLatency, note: `LLM_PROVIDER=${provider} but no LLM_API_KEY -> mock` })
  }
  return createOpenAiCompatibleClient({
    provider: provider as Exclude<LlmProvider, 'mock'>,
    baseUrl: env.LLM_BASE_URL || d.baseUrl,
    apiKey,
    model: env.LLM_MODEL || d.model,
    smallModel: env.LLM_SMALL_MODEL || env.LLM_MODEL || d.small,
    timeoutMs: Number(env.LLM_TIMEOUT_MS || 8000) || 8000,
    stream: env.LLM_STREAM !== '0',
    reasoningEffort: env.LLM_REASONING_EFFORT || 'low',
    minCompletionTokens: Number(env.LLM_MIN_COMPLETION_TOKENS || 400) || 400,
    maxRequests: env.LLM_MAX_REQUESTS ? Number(env.LLM_MAX_REQUESTS) : undefined,
    fetchImpl,
  })
}
