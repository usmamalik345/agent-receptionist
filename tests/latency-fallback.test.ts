/**
 * Replay test: primary responder ("LLM") artificially delayed past the first-audio budget.
 * Asserts (1) fallback triggers, (2) first audio is still within budget + tolerance,
 * (3) the reason is logged in the decision log, (4) token cap -> smaller model -> human.
 * (Same idea as Pipecat PR #5760's function-call timeout, applied to this Express/TS stack.)
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AgentRuntime } from '../server/agentTurn.ts'
import { AnswerCache, FILLER_TEXT, loadLatencyConfig, respondWithinBudget, TokenBudget, type Responder } from '../server/latency.ts'
import type { RouterDecision } from '../server/router.ts'
import type { TurnTrace } from '../server/tracing.ts'

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      reject(new Error('aborted'))
    })
  })
const slow = (ms: number, text = 'slow answer'): Responder => ({
  name: 'slow-llm',
  respond: async ({ signal }) => {
    await sleep(ms, signal)
    return { text, tokens: { prompt: 100, completion: 20 } }
  },
})
const fast = (text = 'fast answer'): Responder => ({ name: 'small', respond: async () => ({ text, tokens: { prompt: 50, completion: 0 } }) })
const failing: Responder = { name: 'broken', respond: async () => Promise.reject(new Error('503 upstream')) }

const BUDGET = 800
const TOLERANCE = 120
const cfg = loadLatencyConfig({ LATENCY_BUDGET_FIRST_AUDIO_MS: String(BUDGET), MAX_TOKENS_PER_CALL: '6000' })
const deps = (primary: Responder, fallback: Responder, tokens = new TokenBudget(cfg.maxTokensPerCall)) => ({
  config: cfg,
  primary,
  fallback,
  cache: new AnswerCache(60_000),
  tokens,
})

test('defaults: 800 ms budget, 6000 token cap', () => {
  const d = loadLatencyConfig({})
  assert.equal(d.budgetMs, 800)
  assert.equal(d.maxTokensPerCall, 6000)
})

test('slow primary -> smaller model, filler first audio inside budget', async () => {
  const r = await respondWithinBudget('c1', 'mm-dental', 'hello', deps(slow(2000), fast('small says hi')))
  assert.equal(r.fallback?.reason, 'budget_exceeded')
  assert.equal(r.step, 'smaller_model')
  assert.equal(r.firstAudioText, FILLER_TEXT)
  assert.ok(r.firstAudioAtMs <= BUDGET + TOLERANCE, `first audio at ${r.firstAudioAtMs}ms`)
  assert.equal(r.text, 'small says hi')
})

test('slow primary with cached answer -> cache', async () => {
  const d = deps(slow(2000), fast())
  d.cache.set(d.cache.key('What are your hours?', 'mm-dental', cfg.policyVersion), 'cached hours')
  const r = await respondWithinBudget('c2', 'mm-dental', 'what are your HOURS', d)
  assert.equal(r.step, 'cache')
  assert.equal(r.text, 'cached hours')
  assert.ok(r.firstAudioAtMs <= BUDGET + TOLERANCE)
})

test('primary error; fallback also slow -> filler + human (llm_timeout)', async () => {
  const r = await respondWithinBudget('c3', 'mm-dental', 'hello', { ...deps(failing, slow(5000)), config: { ...cfg, fallbackTimeoutMs: 200 } })
  assert.equal(r.handoff, true)
  assert.equal(r.step, 'human')
  assert.equal(r.fallback?.reason, 'llm_timeout')
  assert.equal(r.firstAudioText, FILLER_TEXT)
  assert.ok(r.firstAudioAtMs <= BUDGET + TOLERANCE)
})

test('token cap: first breach -> smaller model, second -> human', async () => {
  const tokens = new TokenBudget(100)
  tokens.add('c4', 100)
  const d = deps(fast('primary'), fast('small'), tokens)
  const a = await respondWithinBudget('c4', 'mm-dental', 'one more question', d)
  assert.equal(a.fallback?.reason, 'token_cap')
  assert.equal(a.step, 'smaller_model')
  assert.equal(a.text, 'small')
  const b = await respondWithinBudget('c4', 'mm-dental', 'and another', d)
  assert.equal(b.fallback?.reason, 'token_cap')
  assert.equal(b.handoff, true)
})

test('replayed call through the runtime: delayed LLM -> fallback logged with reason', async () => {
  const decisions: RouterDecision[] = []
  const traces: TurnTrace[] = []
  const agent = new AgentRuntime({
    config: cfg,
    stdout: false,
    decisionSink: (d) => decisions.push(d as RouterDecision),
    traceSink: (t) => traces.push(t as TurnTrace),
    primary: () => slow(2000),
  })
  const { callId } = agent.start({ business: 'mm-dental', source: 'replay' })
  const r = await agent.turn(callId, 'What time are you open on Saturday?')
  assert.match(r.text, /Uppingham/) // fallback = real engine, answer still correct
  assert.equal(r.firstAudioText, FILLER_TEXT)
  const fb = decisions.find((d) => d.fallback_reason)
  assert.ok(fb, 'fallback decision logged')
  assert.equal(fb.fallback_reason, 'budget_exceeded')
  assert.equal(traces[0].fallback?.reason, 'budget_exceeded')
  assert.ok((traces[0].first_audio_ready_ms ?? Infinity) <= BUDGET + TOLERANCE)
})
