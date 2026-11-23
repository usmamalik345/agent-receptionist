/** Bug fix: fillers ("hmm", "umm", "uh", "haan", "ok") were stored as the patient's name. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AgentRuntime } from '../server/agentTurn.ts'
import { isFillerUtterance } from '../src/lib/dentalEngine.ts'

test('isFillerUtterance: fillers yes, names no', () => {
  for (const f of ['hmm', 'Hmm.', 'umm', 'uh...', 'erm', 'haan', 'haan ji', 'ok', 'okay', 'mmm', 'hmm hmm', 'uhh ok']) {
    assert.equal(isFillerUtterance(f), true, f)
  }
  for (const n of ['Priya', 'Priya Shah', 'James Patel', 'Hamza', 'Umar Khan', 'Ahmed']) {
    assert.equal(isFillerUtterance(n), false, n)
  }
})

test('collect_name: filler re-asks, real name accepted', async () => {
  const agent = new AgentRuntime({ stdout: false, traceSink: () => {}, decisionSink: () => {} })
  for (const filler of ['hmm', 'umm', 'uh', 'haan', 'ok']) {
    const { callId } = agent.start({ business: 'mm-dental', source: 'eval' })
    await agent.turn(callId, "I'd like to register as a new patient")
    const r = await agent.turn(callId, filler)
    assert.equal(r.step, 'collect_name', `${filler} -> ${r.step}`)
    assert.equal(r.booking.guestName, '', `${filler} stored as name`)
    const ok = await agent.turn(callId, 'Priya Shah')
    assert.equal(ok.booking.guestName, 'Priya Shah')
    agent.end(callId)
  }
})
