import assert from 'node:assert/strict'
import { test } from 'node:test'
import { diffDecisions, type Decision } from '../scripts/decision-diff.mts'

const d = (fixture: string, turn_index: number, route: string, extra: Partial<Decision> = {}): Decision => ({
  fixture, turn_index, route, reason: 'known_intent', matched_rule: null, intent: 'hours', risk: 'low', fallback_reason: null, ...extra,
})

test('decision diff: identical runs -> no changes', () => {
  const a = [d('r1', 1, 'rule'), d('r2', 1, 'retrieval')]
  assert.deepEqual(diffDecisions(a, a.map((x) => ({ ...x }))), { changed: [], added: [], removed: [], routeChanges: 0 })
})

test('decision diff: route change, new fallback record, removed turn', () => {
  const a = [d('r1', 1, 'rule'), d('r2', 1, 'retrieval'), d('r3', 1, 'tool')]
  const b = [d('r1', 1, 'human', { reason: 'low_confidence:x' }), d('r2', 1, 'retrieval'), d('r2', 1, 'retrieval', { fallback_reason: 'budget_exceeded' })]
  const r = diffDecisions(a, b)
  assert.equal(r.routeChanges, 1)
  assert.deepEqual(r.added, ['r2#1.2'])
  assert.deepEqual(r.removed, ['r3#1.1'])
  assert.ok(r.changed.some((c) => c.field === 'reason' && c.to === 'low_confidence:x'))
})
