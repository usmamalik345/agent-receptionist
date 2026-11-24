/** Targets set from data: per-call token cap (enforced) and caller-silence budget (re-prompt, then hand-off). */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AgentRuntime } from '../server/agentTurn.ts'
import { LruCache } from '../server/cache.ts'
import { loadLatencyConfig, respondWithinBudget, SILENCE_HANDOFF_TEXT, SILENCE_REPROMPT_TEXT, SilenceMonitor, TokenBudget, type Responder } from '../server/latency.ts'

const cfg = loadLatencyConfig({})
/** Responder that reports the worst real per-answer usage seen on Groq (544 tokens). */
const worst = (name: string): Responder => ({ name, respond: async () => ({ text: name, tokens: { prompt: 444, completion: 100 }, model: name }) })

test('token cap 2500: 4 worst-case answers fit, 5th -> small model (short context), 6th -> human', async () => {
  const tokens = new TokenBudget(cfg.maxTokensPerCall)
  const deps = { config: cfg, primary: worst('primary'), fallback: worst('small'), cache: new LruCache(1000), tokens }
  const steps: string[] = []
  for (let i = 0; i < 6; i++) steps.push((await respondWithinBudget('call-x', 'mm-dental', `question number ${i}`, deps)).step)
  assert.deepEqual(steps, ['primary', 'primary', 'primary', 'primary', 'smaller_model', 'human'])
  assert.ok(tokens.usedBy('call-x') <= cfg.maxTokensPerCall + 544, 'at most one answer over the cap (the short-context one)')
})

test('token cap is per call: another call is unaffected', async () => {
  const tokens = new TokenBudget(cfg.maxTokensPerCall)
  tokens.add('a', 5000)
  const r = await respondWithinBudget('b', 'mm-dental', 'hello', { config: cfg, primary: worst('primary'), fallback: worst('small'), cache: new LruCache(1000), tokens })
  assert.equal(r.step, 'primary')
})

test('silence monitor: under budget waits, first breach re-prompts, second hands off, speech resets', () => {
  const m = new SilenceMonitor(7000)
  assert.equal(m.check('c', 6999).action, 'wait')
  assert.deepEqual(m.check('c', 7000), { action: 'reprompt', text: SILENCE_REPROMPT_TEXT })
  m.reset('c')
  assert.equal(m.check('c', 8000).action, 'reprompt')
  assert.deepEqual(m.check('c', 9000), { action: 'handoff', text: SILENCE_HANDOFF_TEXT })
})

test('runtime: silence -> re-prompt, caller speaks (reset), silence twice -> escalated', async () => {
  const agent = new AgentRuntime({ stdout: false, traceSink: () => {}, decisionSink: () => {} })
  const { callId } = agent.start({ business: 'mm-dental', source: 'eval' })
  assert.equal(agent.silence(callId, 2000).action, 'wait')
  assert.equal(agent.silence(callId, 7500).action, 'reprompt')
  await agent.turn(callId, 'Do you accept new patients?')
  assert.equal(agent.silence(callId, 7500).action, 'reprompt')
  assert.equal(agent.silence(callId, 7500).action, 'handoff')
})
