/**
 * Decision-log diff between two replay runs (same fixtures, e.g. main vs PR).
 *   npm run replay:diff                                        baseline vs metrics/replay/latest
 *   npm run replay:diff -- old/decisions.jsonl new/decisions.jsonl [--fail-on-change]
 * Compares route, reason, matched_rule, intent, risk and fallback per (fixture, turn, record#).
 * Any route change must be explained in the pull request. Writes metrics/decision-diff.md.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mdTable, readJsonl } from './trace-utils.mts'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const files = argv.filter((a) => !a.startsWith('--'))
const oldFile = files[0] ?? path.join(ROOT, 'evals', 'replay', 'baseline.decisions.jsonl')
const newFile = files[1] ?? path.join(ROOT, 'metrics', 'replay', 'latest', 'decisions.jsonl')

export interface Decision {
  fixture: string
  turn_index: number
  route: string
  reason: string
  matched_rule: string | null
  intent: string
  risk: string | null
  fallback_reason: string | null
}
const FIELDS: Array<keyof Decision> = ['route', 'reason', 'matched_rule', 'intent', 'risk', 'fallback_reason']

export function keyed(ds: Decision[]): Map<string, Decision> {
  const seen = new Map<string, number>()
  const out = new Map<string, Decision>()
  for (const d of ds) {
    const base = `${d.fixture}#${d.turn_index}`
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    out.set(`${base}.${n}`, d)
  }
  return out
}

export function diffDecisions(a: Decision[], b: Decision[]) {
  const A = keyed(a)
  const B = keyed(b)
  const changed: Array<{ key: string; field: string; from: unknown; to: unknown }> = []
  const removed = [...A.keys()].filter((k) => !B.has(k))
  const added = [...B.keys()].filter((k) => !A.has(k))
  for (const [k, d] of A) {
    const e = B.get(k)
    if (!e) continue
    for (const f of FIELDS) if ((d[f] ?? null) !== (e[f] ?? null)) changed.push({ key: k, field: f, from: d[f] ?? null, to: e[f] ?? null })
  }
  return { changed, added, removed, routeChanges: changed.filter((c) => c.field === 'route').length }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isMain) {
  const a = readJsonl<Decision>(oldFile)
  const b = readJsonl<Decision>(newFile)
  if (!a.length || !b.length) {
    console.error(`missing decisions: ${a.length ? '' : oldFile} ${b.length ? '' : newFile}`)
    process.exit(2)
  }
  const d = diffDecisions(a, b)
  const lines = [
    '# Decision-log diff',
    '',
    `old: \`${path.relative(ROOT, oldFile)}\` (${a.length} records) -> new: \`${path.relative(ROOT, newFile)}\` (${b.length} records)`,
    '',
    `Route changes: **${d.routeChanges}** - field changes: **${d.changed.length}** - added records: **${d.added.length}** - removed records: **${d.removed.length}**`,
    '',
  ]
  if (d.changed.length) lines.push(mdTable(['fixture#turn.record', 'field', 'old', 'new'], d.changed.map((c) => [c.key, c.field, String(c.from), String(c.to)])), '')
  if (d.added.length) lines.push(`Added: ${d.added.join(', ')}`, '')
  if (d.removed.length) lines.push(`Removed: ${d.removed.join(', ')}`, '')
  if (!d.changed.length && !d.added.length && !d.removed.length) lines.push('No decision changes.')
  const out = path.join(ROOT, 'metrics', 'decision-diff.md')
  mkdirSync(path.dirname(out), { recursive: true })
  writeFileSync(out, lines.join('\n') + '\n')
  console.log(lines.join('\n'))
  if (argv.includes('--fail-on-change') && (d.changed.length || d.added.length || d.removed.length)) {
    console.error('DECISION_DIFF_FAIL: decisions changed vs baseline. Explain in the PR, then refresh with npm run replay -- --write-baseline')
    process.exit(1)
  }
}
