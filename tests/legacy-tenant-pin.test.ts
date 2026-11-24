/** Isolation fix: concurrent calls for different businesses must not answer with the other business's engine. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AgentRuntime } from '../server/agentTurn.ts'
import { createMockClient } from '../server/llm.ts'

test('interleaved erth + mm-dental turns each keep their own business', async () => {
  const agent = new AgentRuntime({ stdout: false, traceSink: () => {}, decisionSink: () => {}, llm: createMockClient({ latencyMs: 20 }) })
  const d = agent.start({ business: 'mm-dental', source: 'eval' })
  const h = agent.start({ business: 'erth', source: 'eval' })
  const [rd, rh] = await Promise.all([agent.turn(d.callId, 'Do you accept new patients?'), agent.turn(h.callId, 'Is there parking?')])
  assert.doesNotMatch(rd.text, /erth|resort|room/i)
  assert.doesNotMatch(rh.text, /dental|patient|NHS/i)
})
