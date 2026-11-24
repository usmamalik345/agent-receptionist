/** Cost model: dated price table from config, mock = $0, unknown model = null (never guessed). */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AgentRuntime } from '../server/agentTurn.ts'
import { CallLedger, llmCostUsd, loadPriceTable } from '../server/cost.ts'
import { loadLatencyConfig } from '../server/latency.ts'

test('price table is dated config', () => {
  const t = loadPriceTable()
  assert.match(t.as_of, /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(t.models['mock-primary'].input_per_1m, 0)
})

test('cost formula: tokens * per-1M rates; unknown model -> null', () => {
  const t = loadPriceTable()
  const c = llmCostUsd(t, 'openai/gpt-oss-20b', { prompt: 1_000_000, completion: 1_000_000 })
  assert.equal(c, t.models['openai/gpt-oss-20b'].input_per_1m + t.models['openai/gpt-oss-20b'].output_per_1m)
  assert.equal(llmCostUsd(t, 'some-unpriced-model', { prompt: 10, completion: 10 }), null)
  assert.equal(llmCostUsd(t, 'rule-engine', null), 0)
})

test('ledger: per-call tokens, cost, cap hits, small-model turns', () => {
  const l = new CallLedger()
  l.addTurn('c', { tokens: { prompt: 100, completion: 20 }, costUsd: 0.001, tokenCapHit: false, smallModel: false })
  l.addTurn('c', { tokens: null, costUsd: null, tokenCapHit: true, smallModel: true })
  assert.deepEqual(l.get('c'), { tokens: 120, cost: 0.001, unpriced: 1, capHits: 1, turns: 2, small: 1 })
})

test('runtime records tokens + cost per turn; token cap -> small model then human', async () => {
  const agent = new AgentRuntime({
    stdout: false, traceSink: () => {}, decisionSink: () => {}, multiAgent: true,
    config: loadLatencyConfig({ MAX_TOKENS_PER_CALL: '150', TOKEN_RESERVE_PER_ANSWER: '0' }),
  })
  const { callId } = agent.start({ business: 'mm-dental', source: 'eval' })
  const a = await agent.turn(callId, 'What payment options do you have?')
  assert.ok(a.trace.tokens && a.trace.tokens.prompt > 0)
  assert.equal(a.trace.tokens_estimated, true)
  assert.equal(a.trace.cost_usd, 0)
  const b = await agent.turn(callId, 'Do you accept new patients?')
  assert.equal(b.trace.token_cap_hit, true)
  assert.equal(b.trace.fallback?.step, 'smaller_model')
  const c = await agent.turn(callId, 'What payment options do you have again?')
  assert.equal(c.trace.fallback?.reason, 'token_cap')
  assert.equal(c.handoff, true)
  assert.equal(agent.ledger.get(callId).capHits, 2)
})
