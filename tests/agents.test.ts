/** Triage (risk), retrieval (BM25 + citations), response agent (mock LLM) and the guard. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mmDentalBusiness } from '../src/businesses/mm-dental.ts'
import { AgentRuntime } from '../server/agentTurn.ts'
import { guardReply, SAFE_LINE } from '../server/agents/guard.ts'
import { extractCitations, runResponseAgent } from '../server/agents/response.ts'
import { buildPassages, retrieve } from '../server/agents/retrieval.ts'
import { assessRisk } from '../server/agents/triage.ts'
import { createMockClient, type LlmClient } from '../server/llm.ts'

const quiet = { stdout: false, traceSink: () => {}, decisionSink: () => {} }

test('triage risk: severe swelling/breathing = high, emergency = medium, FAQ = low', () => {
  assert.equal(assessRisk("My face has severe swelling and it's hard to swallow", 'emergency' as never), 'high')
  assert.equal(assessRisk("I've got toothache", 'emergency' as never), 'medium')
  assert.equal(assessRisk('Do you accept new patients?', 'faq'), 'low')
})

test('passages come only from the business config', () => {
  const ids = buildPassages(mmDentalBusiness).map((p) => p.id)
  assert.ok(ids.includes('faq:0') && ids.includes('price:0') && ids.includes('hours:uppingham-road-practice'))
})

test('retrieval: BM25 ranks the right passage and returns citations, misses return nothing', () => {
  assert.equal(retrieve(mmDentalBusiness, 'Do you accept new patients?').passages[0].id, 'faq:0')
  assert.equal(retrieve(mmDentalBusiness, 'What payment options do you have?').passages[0].id, 'faq:1')
  assert.match(retrieve(mmDentalBusiness, 'What time are you open on Saturday?').passages[0].id, /^hours:/)
  assert.match(retrieve(mmDentalBusiness, 'Where is the Upperton practice?').passages[0].id, /^location:upperton/)
  const miss = retrieve(mmDentalBusiness, 'Can you recommend a good pizza place nearby?')
  assert.equal(miss.passages.length, 0)
  assert.equal(miss.grounded, false)
})

test('response agent (mock): answers from the top passage, cites it, citation stripped for TTS', async () => {
  const passages = retrieve(mmDentalBusiness, 'What payment options do you have?').passages
  const out = await runResponseAgent(createMockClient(), { business: 'MM Dental Care', question: 'What payment options do you have?', passages })
  assert.deepEqual(out.citations, ['faq:1'])
  assert.match(out.text, /membership plans from £13\.50/)
  assert.doesNotMatch(out.text, /\[/)
  assert.equal(out.usage.estimated, true)
})

test('extractCitations ignores ids that were not retrieved', () => {
  const r = extractCitations('Open 9am [hours:x]. Also [faq:9].', new Set(['hours:x']))
  assert.deepEqual(r.citations, ['hours:x'])
  assert.equal(r.spoken, 'Open 9am. Also.')
})

test('guard: invented price/time blocked, grounded passes, PII phone blocked, length capped', () => {
  const grounding = ['Membership plans: Start from £13.50 a month.', 'Uppingham Road Practice opening hours: Saturday 9am–12pm.']
  assert.equal(guardReply({ text: 'Plans start from £13.50 a month.', source: 'llm', grounding }).ok, true)
  const price = guardReply({ text: 'A crown is £450.', source: 'llm', grounding })
  assert.equal(price.blocked, true)
  assert.equal(price.text, SAFE_LINE)
  assert.equal(price.violations[0].kind, 'ungrounded_price')
  assert.equal(guardReply({ text: 'We open at 7am on Saturday.', source: 'llm', grounding }).violations[0].kind, 'ungrounded_time')
  assert.equal(guardReply({ text: 'We open 9am to 12pm.', source: 'llm', grounding }).ok, true)
  const pii = guardReply({ text: 'Call Sarah on 07700 900456.', source: 'llm', grounding, allowedContacts: ['0116 276 7760'] })
  assert.equal(pii.violations[0].kind, 'pii_phone')
  assert.equal(guardReply({ text: 'Call us on 0116 276 7760.', source: 'llm', grounding, allowedContacts: ['0116 276 7760'] }).ok, true)
  const long = guardReply({ text: 'We are open. '.repeat(60), source: 'llm', grounding, maxChars: 120 })
  assert.ok(long.text.length <= 120 && long.ok)
  // Engine copy is never truncated (it carries safety lines) - length is a warning only
  const eng = guardReply({ text: 'x '.repeat(300), source: 'engine', grounding, maxChars: 120 })
  assert.equal(eng.text.length, 600)
})

test('runtime: retrieval turn goes through retrieval + response agents with a citation', async () => {
  const agent = new AgentRuntime({ ...quiet, multiAgent: true, llm: createMockClient() })
  const { callId } = agent.start({ business: 'mm-dental', source: 'eval' })
  const r = await agent.turn(callId, 'What payment options do you have?')
  assert.equal(r.route, 'retrieval')
  assert.equal(r.trace.agent_path, 'multi_agent')
  assert.deepEqual(r.citations, ['faq:1'])
  assert.equal(r.guard.ok, true)
  assert.equal(r.costUsd, 0)
})

test('runtime: a model that invents a price is blocked by the guard; caller gets the engine answer', async () => {
  const liar: LlmClient = {
    ...createMockClient(),
    complete: async () => ({ text: 'Membership is £9.99 a month [faq:1].', model: 'mock-primary', provider: 'mock', usage: { prompt: 10, completion: 10, estimated: true }, ttftMs: 1 }),
  }
  const agent = new AgentRuntime({ ...quiet, multiAgent: true, llm: liar })
  const { callId } = agent.start({ business: 'mm-dental', source: 'eval' })
  const r = await agent.turn(callId, 'What payment options do you have?')
  assert.equal(r.guard.blocked, true)
  assert.doesNotMatch(r.text, /9\.99/)
  assert.match(r.text, /£13\.50/)
})

test('runtime: MULTI_AGENT off -> engine path only', async () => {
  const agent = new AgentRuntime({ ...quiet, multiAgent: false })
  const { callId } = agent.start({ business: 'mm-dental', source: 'eval' })
  const r = await agent.turn(callId, 'What payment options do you have?')
  assert.equal(r.trace.agent_path, 'engine')
})

test('extractCitations normalises typographic characters real models emit (gpt-oss: U+202F in phone numbers)', () => {
  const out = extractCitations('Call 0116\u202f247\u202f0431 for a same\u2011day slot, we\u2019re here. [location:upperton-road-practice]', new Set(['location:upperton-road-practice']))
  assert.equal(out.spoken, "Call 0116 247 0431 for a same-day slot, we're here.")
  assert.deepEqual(out.citations, ['location:upperton-road-practice'])
})

test('retrieval reaches hours/address passages from plain wording; hours passage keeps location notes', () => {
  assert.match(retrieve(mmDentalBusiness, 'Where are you based?').passages[0].id, /^location:/)
  assert.match(retrieve(mmDentalBusiness, 'Which day are you closed?').passages[0].id, /^hours:/)
  const upperton = buildPassages(mmDentalBusiness).find((p) => p.id === 'hours:upperton-road-practice')!
  assert.match(upperton.text, /Saturday 9am–12pm phone lines only, Sunday closed\. Note: Saturday patients are seen at Uppingham Road/)
})

test('guard: day/time consistency per location blocks a wrong closing time that is grounded for another day', () => {
  const grounding = buildPassages(mmDentalBusiness).filter((p) => p.source === 'hours').map((p) => p.text)
  const hours = mmDentalBusiness.locations
  const wrong = guardReply({ text: 'The Uppingham Road practice closes at 5 pm on Tuesday.', source: 'llm', grounding, hours })
  assert.equal(wrong.blocked, true)
  assert.equal(wrong.violations[0].kind, 'hours_mismatch')
  assert.equal(guardReply({ text: 'The Uppingham Road practice closes at 7pm on Tuesday.', source: 'llm', grounding, hours }).ok, true)
  // two locations in one sentence: not attributed, plain grounding check only
  assert.equal(guardReply({ text: 'On Friday Uppingham Road and Upperton Road are both open 9am to 5pm.', source: 'llm', grounding, hours }).ok, true)
})

test('guard: a time the caller said may be repeated back; a price the caller said may not', () => {
  const grounding = buildPassages(mmDentalBusiness).filter((p) => p.source === 'hours').map((p) => p.text)
  const ok = guardReply({ text: "Sorry, we're not open at 8pm on Friday; Uppingham Road is open 9am to 5pm.", source: 'llm', grounding, hours: mmDentalBusiness.locations, callerText: 'Can I come in at 8pm on Friday?' })
  assert.equal(ok.ok, true)
  const price = guardReply({ text: 'Yes, a filling is £40.', source: 'llm', grounding, callerText: 'Is a filling £40?' })
  assert.equal(price.blocked, true)
})
