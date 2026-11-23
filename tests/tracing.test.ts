import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AgentRuntime } from '../server/agentTurn.ts'
import { CallTrace, memorySink, redactText, sanitizeBrowserTurn, type TurnTrace } from '../server/tracing.ts'

test('one trace id per call, incrementing turn ids, spans timed', async () => {
  const out: object[] = []
  let t = 0
  const trace = new CallTrace('call-1', { source: 'server', sink: memorySink(out), clock: () => t })
  const a = trace.startTurn()
  await a.span('engine', () => {
    t += 12
    return 1
  })
  t += 3
  a.markFirstAudio()
  a.end()
  trace.startTurn().end()
  const [r1, r2] = out as TurnTrace[]
  assert.equal(r1.trace_id, r2.trace_id)
  assert.equal(r1.turn_id, 1)
  assert.equal(r2.turn_id, 2)
  assert.equal(r1.spans[0].name, 'engine')
  assert.equal(r1.spans[0].duration_ms, 12)
  assert.equal(r1.ttfa_ms, 15)
})

test('failed span records error on the turn and rethrows', async () => {
  const trace = new CallTrace('call-2', { source: 'server', sink: memorySink([]) })
  const turn = trace.startTurn()
  await assert.rejects(turn.span('tts', () => Promise.reject(new Error('edge_tts exit 1'))))
  const rec = turn.end()
  assert.equal(rec.spans[0].ok, false)
  assert.match(String(rec.error), /tts: edge_tts exit 1/)
})

test('end() writes exactly once', () => {
  const out: object[] = []
  const turn = new CallTrace('c', { source: 'server', sink: memorySink(out) }).startTurn()
  turn.end()
  turn.end()
  assert.equal(out.length, 1)
})

test('runtime trace: route, router, tool calls, outcome; no caller text; no invented tokens', async () => {
  const traces: TurnTrace[] = []
  const agent = new AgentRuntime({ stdout: false, decisionSink: () => {}, traceSink: (r) => traces.push(r as TurnTrace) })
  const { callId } = agent.start({ business: 'mm-dental' })
  await agent.turn(callId, 'I need to move my appointment on Thursday. Name Alex Reed, phone 07700900999')
  const tr = traces[0]
  assert.equal(tr.route, 'tool')
  assert.ok(tr.router && tr.router.confidence > 0)
  assert.ok(tr.tool_calls.length > 0)
  assert.equal(tr.outcome, 'callback_requested')
  assert.equal(tr.user_text, undefined)
  assert.ok(tr.spans.some((s) => s.name === 'router'))
  assert.ok(tr.spans.some((s) => s.name === 'engine'))
  assert.equal(tr.tokens, null)
})

test('redaction masks digits', () => {
  assert.equal(redactText('call 07700 900123'), 'call ##### ######')
})

test('browser trace sanitizer whitelists fields and drops text', () => {
  const r = sanitizeBrowserTurn({ call_id: 'x', turn_id: 2, route: 'rule', ttfa_ms: 640, user_text: 'secret 0770', router: { reason: 'known_intent', confidence: 0.95 }, evil: 1 })
  assert.ok(r)
  const rec = r.turn as unknown as Record<string, unknown>
  assert.equal(r.turn.ttfa_ms, 640)
  assert.equal(r.turn.source, 'browser')
  assert.equal(rec.user_text, undefined)
  assert.equal(rec.evil, undefined)
  assert.equal(r.decision?.route, 'rule')
  assert.equal(sanitizeBrowserTurn({}), null)
})
