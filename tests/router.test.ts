import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mmDentalBusiness } from '../src/businesses/mm-dental.ts'
import { setActiveBusiness } from '../src/lib/businessRuntime.ts'
import { buildRetrievalCorpus, ClarificationTracker, HUMAN_CONFIDENCE_THRESHOLD, isFailedClarification, routeTurn, type RouterContext } from '../server/router.ts'
import { AgentRuntime } from '../server/agentTurn.ts'
import { memorySink } from '../server/tracing.ts'

setActiveBusiness('mm-dental')
const ctx = (over: Partial<RouterContext> = {}): RouterContext => ({
  callId: 'c1',
  turnId: 1,
  step: 'await_intent',
  industry: 'dental',
  corpus: buildRetrievalCorpus(mmDentalBusiness),
  ...over,
})

test('rule route for known deterministic intents', () => {
  for (const text of ['What time are you open on Saturday?', 'How much is an emergency appointment?', 'Do you do membership plans?', "I've got really bad toothache"]) {
    const d = routeTurn(text, ctx())
    assert.equal(d.route, 'rule', text)
    assert.ok(d.matched_rule?.startsWith('intent:'))
    assert.ok(d.confidence >= HUMAN_CONFIDENCE_THRESHOLD)
  }
})

test('tool route for booking / reschedule', () => {
  assert.equal(routeTurn("I'd like to register as a new patient", ctx()).route, 'tool')
  assert.equal(routeTurn('I need to move my appointment on Thursday', ctx()).route, 'tool')
})

test('tool route (slot filling) while collecting fields', () => {
  const d = routeTurn('yes', ctx({ step: 'confirm_summary' }))
  assert.equal(d.route, 'tool')
  assert.equal(d.reason, 'slot_filling')
})

test('retrieval route on FAQ corpus match', () => {
  const d = routeTurn('What payment options do you have?', ctx())
  assert.equal(d.route, 'retrieval')
  assert.match(String(d.matched_rule), /^faq:/)
})

test('human route: explicit ask', () => {
  const d = routeTurn('Can I speak to a receptionist?', ctx())
  assert.equal(d.route, 'human')
  assert.equal(d.reason, 'caller_asked_for_human')
})

test('human route: low confidence (< 0.55)', () => {
  const d = routeTurn('Can you recommend a good pizza place nearby?', ctx())
  assert.equal(d.route, 'human')
  assert.ok(d.confidence < HUMAN_CONFIDENCE_THRESHOLD)
  assert.match(d.reason, /^low_confidence/)
})

test('human route: 2 failed clarifications', () => {
  const d = routeTurn('What payment options do you have?', ctx({ failedClarifications: 2 }))
  assert.equal(d.route, 'human')
  assert.equal(d.reason, 'repeated_clarification_failure')
})

test('decision record has the logged fields', () => {
  const d = routeTurn('What time are you open on Saturday?', ctx({ callId: 'abc', turnId: 3 }))
  for (const k of ['call_id', 'turn_id', 'route', 'reason', 'confidence', 'matched_rule', 'latency_ms']) assert.ok(k in d, k)
  assert.equal(d.call_id, 'abc')
  assert.equal(d.turn_id, 3)
})

test('failed clarification detection + tracker', () => {
  assert.equal(isFailedClarification('collect_name', { nextStep: 'collect_name', bookingUpdates: { language: 'en' } }), true)
  assert.equal(isFailedClarification('collect_name', { nextStep: 'collect_phone', bookingUpdates: { guestName: 'A B' } }), false)
  // re-sending an already-captured value is not progress
  assert.equal(isFailedClarification('collect_phone', { nextStep: 'collect_phone', bookingUpdates: { guestName: 'A B' } }, { guestName: 'A B' }), true)
  const t = new ClarificationTracker()
  t.record('x', true)
  assert.equal(t.record('x', true), 2)
  assert.equal(t.record('x', false), 0)
})

test('router decisions are logged per turn through the runtime', async () => {
  const decisions: object[] = []
  const traces: object[] = []
  const agent = new AgentRuntime({ stdout: false, decisionSink: memorySink(decisions), traceSink: memorySink(traces) })
  const { callId } = agent.start({ business: 'mm-dental' })
  await agent.turn(callId, 'What time are you open on Saturday?')
  await agent.turn(callId, 'agent please')
  assert.equal(decisions.length, 2)
  assert.equal(traces.length, 2)
})
