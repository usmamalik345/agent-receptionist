/** Bug fix: hours answers come from config via get_hours, never from model recall (real gpt-oss said Uppingham closes 5pm Tue; config 7pm). */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { answerHoursQuestion, isHoursQuestion } from '../server/agents/hoursTool.ts'
import { runResponseAgent } from '../server/agents/response.ts'
import { retrieve } from '../server/agents/retrieval.ts'
import type { LlmClient } from '../server/llm.ts'
import { AgentRuntime } from '../server/agentTurn.ts'
import { mmDentalBusiness } from '../src/businesses/index.ts'

/** An LLM that always gives the exact wrong answer seen in the real run. */
const wrongLlm = (): LlmClient & { calls: number } => {
  const c = {
    provider: 'mock' as const, primaryModel: 'wrong', smallModel: 'wrong-small', note: 'test', calls: 0,
    async complete() {
      c.calls++
      return { text: 'Uppingham Road closes at 5pm on Tuesday. [hours:uppingham-road-practice]', model: 'wrong', provider: 'mock' as const, usage: { prompt: 10, completion: 10, estimated: false }, ttftMs: 1 }
    },
  }
  return c
}

test('get_hours: Uppingham Tuesday = 7pm from config', () => {
  const a = answerHoursQuestion(mmDentalBusiness.locations, 'What time does Uppingham close on Tuesday?')!
  assert.match(a.text, /Tuesday 8:30am to 7pm/)
  assert.doesNotMatch(a.text, /5pm/)
  assert.deepEqual(a.citations, ['hours:uppingham-road-practice'])
  const both = answerHoursQuestion(mmDentalBusiness.locations, 'Are you open on Sunday?')!
  assert.equal(both.locations.length, 2)
  assert.match(both.text, /closed on Sunday/)
  assert.equal(isHoursQuestion('How much is a filling?'), false)
  assert.equal(answerHoursQuestion(mmDentalBusiness.locations, 'Do you take new patients?'), null)
})

test('response agent: hours question never reaches the model', async () => {
  const llm = wrongLlm()
  const q = 'What time does Uppingham close on Tuesday?'
  const out = await runResponseAgent(llm, { business: 'MM', question: q, passages: retrieve(mmDentalBusiness, q).passages, hours: mmDentalBusiness.locations })
  assert.equal(llm.calls, 0)
  assert.equal(out.tool, 'get_hours')
  assert.match(out.text, /7pm/)
})

test('runtime: wrong-hours model is bypassed, caller hears the config time', async () => {
  const llm = wrongLlm()
  const agent = new AgentRuntime({ stdout: false, traceSink: () => {}, decisionSink: () => {}, llm })
  const { callId } = agent.start({ business: 'mm-dental', source: 'eval' })
  const r = await agent.turn(callId, 'Until what time is the Uppingham practice open on Tuesday?')
  assert.match(r.text, /Tuesday 8:30am to 7pm/)
  assert.doesNotMatch(r.text, /5pm/)
  assert.equal(llm.calls, 0)
  assert.ok(r.trace.tool_calls?.some((t) => t.tool === 'get_hours'))
})
