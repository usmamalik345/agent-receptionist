/**
 * One replay test per failure-taxonomy category (mapping: evals/taxonomy.json).
 * Each must keep passing. The first test enforces that every category prefix the
 * categorizer can emit (scripts/taxonomy.mts) is mapped to an existing test here.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { AgentRuntime, TOOL_FAILURE_TEXT, type TurnResult } from '../server/agentTurn.ts'
import { SAFE_LINE } from '../server/agents/guard.ts'
import { FILLER_TEXT, loadLatencyConfig } from '../server/latency.ts'
import { abortableSleep, createMockClient, type LlmClient } from '../server/llm.ts'
import type { ToolFn } from '../server/tools.ts'
import type { TurnTrace } from '../server/tracing.ts'
import { checkTurn, type EvalCase } from '../scripts/expect.mts'
import { CATEGORY_PREFIXES, categorize } from '../scripts/taxonomy.mts'
import { readJsonl } from '../scripts/trace-utils.mts'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const BUDGET = 800
const TOL = 150
const cfg = loadLatencyConfig({ LATENCY_BUDGET_FIRST_AUDIO_MS: String(BUDGET), FALLBACK_TIMEOUT_MS: '300' })
const never = () => new Promise<never>(() => {})

function rt(over: Partial<ConstructorParameters<typeof AgentRuntime>[0]> = {}) {
  const traces: TurnTrace[] = []
  const agent = new AgentRuntime({ config: cfg, enforceRouter: true, stdout: false, decisionSink: () => {}, traceSink: (t) => traces.push(t as TurnTrace), multiAgent: true, ...over })
  return { agent, traces }
}
const fixedLlm = (text: string): LlmClient => ({
  ...createMockClient(),
  complete: async (req) => ({ text, model: req.tier === 'small' ? 'mock-small' : 'mock-primary', provider: 'mock', usage: { prompt: 10, completion: 10, estimated: true }, ttftMs: 0 }),
})

test('taxonomy map covers every category prefix with an existing replay test', () => {
  const map = JSON.parse(readFileSync(path.join(ROOT, 'evals', 'taxonomy.json'), 'utf8')) as Record<string, string[] | string>
  const src = readFileSync(fileURLToPath(import.meta.url), 'utf8')
  for (const p of CATEGORY_PREFIXES) {
    const tests = map[p]
    assert.ok(Array.isArray(tests) && tests.length > 0, `category ${p} has no replay test`)
    for (const name of tests) assert.ok(src.includes(`test('${name}'`), `mapped test missing: ${name}`)
  }
})

// ---- full replay of the 100 synthetic calls (shared by several categories) ----
const replay: Array<{ c: EvalCase; i: number; r: TurnResult; errors: string[] }> = []
before(async () => {
  const { agent } = rt()
  for (const c of readJsonl<EvalCase>(path.join(ROOT, 'evals', 'replay', 'calls.jsonl'))) {
    const { callId } = agent.start({ business: c.business, afterHours: c.after_hours, source: 'replay', callId: `t-${c.id}` })
    for (const [i, turn] of c.turns.entries()) {
      const r = await agent.turn(callId, turn.text)
      replay.push({ c, i, r, errors: checkTurn(r, turn.expect) })
    }
  }
})

test('taxonomy: wrong_route -> labelled replay turns route as expected', () => {
  assert.ok(replay.length >= 100)
  const bad = replay.filter((x) => x.errors.length)
  assert.deepEqual(bad.map((x) => `${x.c.id}#${x.i + 1}: ${x.errors.join('; ')}`), [])
})

test('taxonomy: empty_answer -> every replay turn has a non-empty reply', () => {
  for (const x of replay) assert.ok(x.r.text.trim().length > 0, `${x.c.id}#${x.i + 1} empty`)
})

test('taxonomy: handoff -> explicit ask and off-topic go to a human', async () => {
  const { agent, traces } = rt()
  for (const text of ['Can I speak to a receptionist?', 'Can you recommend a good pizza place nearby?']) {
    const { callId } = agent.start({ business: 'mm-dental', source: 'replay' })
    const r = await agent.turn(callId, text)
    assert.equal(r.route, 'human')
    assert.equal(r.handoff, true)
  }
  assert.ok(categorize(traces[1], BUDGET).includes('low_confidence'))
})

test('taxonomy: failed_clarification -> fillers re-ask, two failures hand off', async () => {
  const { agent, traces } = rt()
  const { callId } = agent.start({ business: 'mm-dental', source: 'replay' })
  await agent.turn(callId, "I'd like to register as a new patient")
  const a = await agent.turn(callId, 'hmm')
  assert.equal(a.step, 'collect_name')
  assert.equal(a.booking.guestName, '')
  await agent.turn(callId, 'umm')
  const c = await agent.turn(callId, 'erm')
  assert.equal(c.route, 'human')
  assert.ok(categorize(traces[1], BUDGET).includes('failed_clarification'))
})

test('taxonomy: ungrounded_answer -> invented price or time is blocked', async () => {
  for (const lie of ['Membership is £9.99 a month [faq:1].', 'We open at 6am every day [faq:1].']) {
    const { agent, traces } = rt({ llm: fixedLlm(lie) })
    const { callId } = agent.start({ business: 'mm-dental', source: 'replay' })
    const r = await agent.turn(callId, 'What payment options do you have?')
    assert.equal(r.guard.blocked, true)
    assert.doesNotMatch(r.text, /9\.99|6am/)
    const cats = categorize(traces[0], BUDGET)
    assert.ok(cats.some((x) => x.startsWith('ungrounded_answer')) && cats.includes('guard_blocked'), cats.join())
  }
})

test('taxonomy: pii_leak -> foreign phone number is blocked', async () => {
  const { agent, traces } = rt({ llm: fixedLlm('Ask Sarah Khan, she is on 07700 900456 [faq:1].') })
  const { callId } = agent.start({ business: 'mm-dental', source: 'replay' })
  const r = await agent.turn(callId, 'What payment options do you have?')
  assert.doesNotMatch(r.text, /900456/)
  assert.ok(categorize(traces[0], BUDGET).includes('pii_leak:phone'))
})

test('taxonomy: long_reply -> model output capped, engine safety copy kept whole', async () => {
  const { agent } = rt({ llm: fixedLlm(`${'Pay as you go, or membership plans from £13.50 a month. '.repeat(12)}[faq:1]`), guardMaxChars: 200 })
  const { callId } = agent.start({ business: 'mm-dental', source: 'replay' })
  const r = await agent.turn(callId, 'What payment options do you have?')
  assert.ok(r.text.length <= 200)
  const e = rt({ guardMaxChars: 100 })
  const c2 = e.agent.start({ business: 'mm-dental', source: 'replay' }).callId
  const s = await e.agent.turn(c2, "My face has severe swelling and it's hard to swallow")
  assert.match(s.text, /999|A&E/)
})

test('taxonomy: tool_misuse -> invalid ticket args rejected by schema', async () => {
  const { validateToolCall } = await import('../server/tools.ts')
  assert.match(String(validateToolCall('create_ticket', { reason: 'x', summary: 'y', priority: 'asap' })), /bad priority/)
  assert.match(String(validateToolCall('update_booking_fields', { creditCard: '4111' })), /unknown field/)
  assert.equal(validateToolCall('create_ticket', { reason: 'x', summary: 'y', priority: 'urgent' }), null)
})

const bookingTurns = ["Hi, I'd like to register as a new patient. Name Priya Shah, phone 07700900111, Uppingham Road, check-up next Tuesday morning", 'Yes please']

test('taxonomy: tool_error -> failed ticket tool never claims success', async () => {
  const { agent, traces } = rt({ tools: { create_ticket: async () => Promise.reject(new Error('crm 500')) } })
  const { callId } = agent.start({ business: 'mm-dental', source: 'replay' })
  await agent.turn(callId, bookingTurns[0])
  const r = await agent.turn(callId, bookingTurns[1])
  assert.equal(r.text, TOOL_FAILURE_TEXT)
  assert.ok(categorize(traces[1], BUDGET).includes('tool_error:create_ticket'))
})

test('taxonomy: timeout -> tool progress-then-stall times out and hands off', async () => {
  const stall: ToolFn = async (_a, ctx) => {
    ctx.progress('queued')
    return never()
  }
  const { agent, traces } = rt({ tools: { create_ticket: stall }, toolTimeoutMs: 300 })
  const { callId } = agent.start({ business: 'mm-dental', source: 'replay' })
  await agent.turn(callId, bookingTurns[0])
  const r = await agent.turn(callId, bookingTurns[1])
  assert.equal(r.handoff, true)
  assert.ok(categorize(traces[1], BUDGET).includes('timeout:tool'))
})

const slowPrimary = (ms: number): LlmClient => {
  const m = createMockClient()
  return {
    ...m,
    complete: async (req) => {
      if (req.tier !== 'small') await abortableSleep(ms, req.signal)
      return m.complete(req)
    },
  }
}

test('taxonomy: fallback -> slow primary model uses small model inside budget', async () => {
  const { agent, traces } = rt({ llm: slowPrimary(3000) })
  const { callId } = agent.start({ business: 'mm-dental', source: 'replay' })
  const r = await agent.turn(callId, 'What payment options do you have?')
  assert.ok(r.firstAudioAtMs <= BUDGET + TOL)
  assert.ok(categorize(traces[0], BUDGET).includes('fallback:budget_exceeded'))
})

test('taxonomy: error -> llm error falls back, caller still answered', async () => {
  const m = createMockClient()
  const flaky: LlmClient = { ...m, complete: async (req) => (req.tier === 'small' ? m.complete(req) : Promise.reject(new Error('llm_http_503'))) }
  const { agent, traces } = rt({ llm: flaky })
  const { callId } = agent.start({ business: 'mm-dental', source: 'replay' })
  const r = await agent.turn(callId, 'What payment options do you have?')
  assert.match(r.text, /£13\.50/)
  assert.ok(categorize(traces[0], BUDGET).includes('fallback:llm_error'))
})

test('taxonomy: over_latency_budget -> first audio inside budget under slow model and tool', async () => {
  const { agent, traces } = rt({ llm: slowPrimary(3000), tools: { create_ticket: never }, toolTimeoutMs: 1200 })
  const { callId } = agent.start({ business: 'mm-dental', source: 'replay' })
  const a = await agent.turn(callId, 'What payment options do you have?')
  await agent.turn(callId, bookingTurns[0])
  const b = await agent.turn(callId, bookingTurns[1])
  for (const r of [a, b]) {
    assert.equal(r.firstAudioText, FILLER_TEXT)
    assert.ok(r.firstAudioAtMs <= BUDGET + TOL, `${r.firstAudioAtMs}ms`)
  }
  for (const t of traces) assert.ok(!categorize(t, BUDGET).includes('over_latency_budget'))
  assert.ok(categorize(traces[0], BUDGET).includes('filler_first'))
})

test('taxonomy: token_cap -> small model then human', async () => {
  const { agent, traces } = rt({ config: { ...cfg, maxTokensPerCall: 150 } })
  const { callId } = agent.start({ business: 'mm-dental', source: 'replay' })
  await agent.turn(callId, 'What payment options do you have?')
  await agent.turn(callId, 'Do you accept new patients?')
  const c = await agent.turn(callId, 'Can I pay monthly?')
  assert.equal(c.handoff, true)
  assert.ok(categorize(traces[1], BUDGET).includes('token_cap'))
  assert.ok(categorize(traces[2], BUDGET).includes('fallback:token_cap'))
})

test('guard safe line is a fixed sentence (sanity)', () => {
  assert.match(SAFE_LINE, /team to confirm/)
})
