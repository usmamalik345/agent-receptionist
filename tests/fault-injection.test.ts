/**
 * Fault injection: tool hangs, tool errors, tool sends progress then stalls (the
 * Pipecat PR #5760 failure mode - the deadline must stay armed), STT/TTS slowdowns,
 * model timeout/error. In every case the fallback fires and the caller hears audio
 * (reply or filler) within budget + tolerance.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AgentRuntime, TOOL_FAILURE_TEXT } from '../server/agentTurn.ts'
import { FILLER_TEXT, loadLatencyConfig } from '../server/latency.ts'
import { abortableSleep, createMockClient, type LlmClient } from '../server/llm.ts'
import { runTool, type ToolFn } from '../server/tools.ts'
import type { TurnTrace } from '../server/tracing.ts'
import { runVoiceTurn } from '../server/voicePipeline.ts'

const BUDGET = 800
const TOL = 150
const cfg = loadLatencyConfig({ LATENCY_BUDGET_FIRST_AUDIO_MS: String(BUDGET), FALLBACK_TIMEOUT_MS: '300' })
const never = () => new Promise<never>(() => {})
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function rt(over: Partial<ConstructorParameters<typeof AgentRuntime>[0]> = {}) {
  const traces: TurnTrace[] = []
  const agent = new AgentRuntime({ config: cfg, stdout: false, decisionSink: () => {}, traceSink: (t) => traces.push(t as TurnTrace), multiAgent: true, ...over })
  return { agent, traces }
}

/** Two turns that end in create_ticket (new-patient booking confirmed). */
async function bookAndConfirm(agent: AgentRuntime) {
  const { callId } = agent.start({ business: 'mm-dental', source: 'replay' })
  await agent.turn(callId, "Hi, I'd like to register as a new patient. Name Priya Shah, phone 07700900111, Uppingham Road, check-up next Tuesday morning")
  let first: { text: string; at: number; kind: string } | null = null
  const r = await agent.turn(callId, 'Yes please', { onFirstAudio: (text, at, kind) => (first ??= { text, at, kind }) })
  return { r, first: first! }
}

// ---- tool runner (unit) ----
test('runTool: progress update does NOT disarm the deadline (PR #5760 regression)', async () => {
  const stall: ToolFn = async (_a, ctx) => {
    await sleep(30)
    ctx.progress('checking the diary')
    return never()
  }
  const r = await runTool('lookup', stall, {}, { timeoutMs: 200 })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'timeout')
  assert.deepEqual(r.progress, ['checking the diary'])
  assert.ok(r.ms >= 190 && r.ms < 200 + TOL, `timed out at ${r.ms}ms`)
})

test('runTool control: hanging tool with no progress still times out; progress + final result succeeds', async () => {
  assert.equal((await runTool('hang', never, {}, { timeoutMs: 100 })).error, 'timeout')
  const ok: ToolFn<string> = async (_a, ctx) => {
    ctx.progress('half way')
    await sleep(20)
    return 'done'
  }
  const r = await runTool('ok', ok, {}, { timeoutMs: 200 })
  assert.equal(r.ok, true)
  assert.equal(r.result, 'done')
})

// ---- tool faults through the runtime ----
test('tool hangs -> timeout, filler inside budget, no false "sent" claim, hand-off', async () => {
  const { agent, traces } = rt({ tools: { create_ticket: never }, toolTimeoutMs: 1000 })
  const { r, first } = await bookAndConfirm(agent)
  assert.equal(first.kind, 'filler')
  assert.equal(first.text, FILLER_TEXT)
  assert.ok(first.at <= BUDGET + TOL, `first audio ${first.at}ms`)
  assert.equal(r.text, TOOL_FAILURE_TEXT)
  assert.equal(r.handoff, true)
  const t = traces.at(-1)!
  assert.equal(t.tool_calls.find((c) => c.tool === 'create_ticket')?.ok, false)
  assert.ok(t.spans.some((s) => s.name === 'tool' && !s.ok && s.error === 'timeout'))
})

test('tool sends progress then stalls -> still times out (deadline stays armed)', async () => {
  const progressThenStall: ToolFn = async (_a, ctx) => {
    await sleep(50)
    ctx.progress('ticket queued')
    return never()
  }
  const { agent, traces } = rt({ tools: { create_ticket: progressThenStall }, toolTimeoutMs: 700 })
  const { r, first } = await bookAndConfirm(agent)
  assert.equal(r.handoff, true)
  assert.ok(first.at <= BUDGET + TOL)
  const span = traces.at(-1)!.spans.find((s) => s.name === 'tool')!
  assert.equal(span.ok, false)
  assert.ok(span.duration_ms >= 690 && span.duration_ms < 700 + TOL, `tool span ${span.duration_ms}ms`)
})

test('tool errors -> apology + hand-off immediately (reply is first audio)', async () => {
  const { agent } = rt({ tools: { create_ticket: async () => Promise.reject(new Error('crm 500')) } })
  const { r, first } = await bookAndConfirm(agent)
  assert.equal(r.text, TOOL_FAILURE_TEXT)
  assert.equal(r.handoff, true)
  assert.equal(first.kind, 'reply')
  assert.ok(first.at <= BUDGET)
})

// ---- model faults ----
const tiered = (primaryMs: number, smallMs: number, fail = false): LlmClient => {
  const base = createMockClient()
  return {
    ...base,
    complete: async (req) => {
      if (fail && req.tier !== 'small') throw new Error('llm_http_503')
      await abortableSleep(req.tier === 'small' ? smallMs : primaryMs, req.signal)
      return base.complete(req)
    },
  }
}

test('model timeout (primary slow) -> small model, filler within budget', async () => {
  const { agent, traces } = rt({ llm: tiered(3000, 10) })
  const { callId } = agent.start({ business: 'mm-dental', source: 'replay' })
  const r = await agent.turn(callId, 'What payment options do you have?')
  assert.equal(r.firstAudioText, FILLER_TEXT)
  assert.ok(r.firstAudioAtMs <= BUDGET + TOL)
  assert.equal(traces[0].fallback?.reason, 'budget_exceeded')
  assert.equal(traces[0].fallback?.step, 'smaller_model')
  assert.match(r.text, /£13\.50/)
})

test('model timeout on both tiers -> filler + human hand-off within budget', async () => {
  const { agent, traces } = rt({ llm: tiered(3000, 3000) })
  const { callId } = agent.start({ business: 'mm-dental', source: 'replay' })
  const r = await agent.turn(callId, 'What payment options do you have?')
  assert.equal(r.handoff, true)
  assert.equal(r.firstAudioText, FILLER_TEXT)
  assert.ok(r.firstAudioAtMs <= BUDGET + TOL)
  assert.equal(traces[0].fallback?.reason, 'llm_timeout')
})

test('model error -> llm_error fallback; cached answer served when available', async () => {
  const { agent, traces } = rt({ llm: tiered(0, 0, true) })
  const { callId } = agent.start({ business: 'mm-dental', source: 'replay' })
  const a = await agent.turn(callId, 'What payment options do you have?')
  assert.equal(traces[0].fallback?.reason, 'llm_error')
  assert.match(a.text, /£13\.50/)
  // healthy model fills the cache; next identical question is a cache hit (no model call)
  const healthy = rt()
  const c2 = healthy.agent.start({ business: 'mm-dental', source: 'replay' }).callId
  await healthy.agent.turn(c2, 'What payment options do you have?')
  const hit = await healthy.agent.turn(c2, 'what payment options do you have')
  assert.equal(hit.cacheHit, true)
  assert.equal(hit.trace.tokens, null)
})

// ---- STT / TTS slowdowns (simulated voice turn) ----
const fastTts = { firstByte: async () => {} }

test('STT slowdown eats the budget: LLM deadline shrinks, filler still within budget', async () => {
  const { agent } = rt({ llm: tiered(3000, 10) })
  const { callId } = agent.start({ business: 'mm-dental', source: 'replay' })
  const stt = { transcribe: async (a: { text: string }) => (await sleep(450), a.text) }
  const v = await runVoiceTurn(agent, callId, { text: 'What payment options do you have?' }, { stt, tts: fastTts })
  assert.ok(v.sttMs >= 440)
  assert.equal(v.turn.firstAudioText, FILLER_TEXT)
  assert.ok(v.ttfaMs <= BUDGET + TOL, `ttfa ${v.ttfaMs}ms`)
})

test('TTS slowdown: pre-rendered filler clip plays at the budget', async () => {
  const { agent } = rt()
  const { callId } = agent.start({ business: 'mm-dental', source: 'replay' })
  const slowTts = { firstByte: async () => void (await sleep(2000)) }
  const stt = { transcribe: async (a: { text: string }) => a.text }
  const v = await runVoiceTurn(agent, callId, { text: 'What time are you open on Saturday?' }, { stt, tts: slowTts })
  assert.equal(v.firstAudioSource, 'filler_clip')
  assert.ok(v.ttfaMs <= BUDGET + TOL, `ttfa ${v.ttfaMs}ms`)
})

test('healthy voice turn: TTS first byte is the first audio, well inside budget', async () => {
  const { agent } = rt()
  const { callId } = agent.start({ business: 'mm-dental', source: 'replay' })
  const v = await runVoiceTurn(agent, callId, { text: 'What time are you open on Saturday?' }, {
    stt: { transcribe: async (a) => a.text },
    tts: { firstByte: async () => void (await sleep(50)) },
  })
  assert.equal(v.firstAudioSource, 'tts')
  assert.ok(v.ttfaMs < BUDGET)
})
