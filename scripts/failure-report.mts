/**
 * Failure categories derived ONLY from fields present in real traces -> metrics/failures.md
 *   npm run report:failures                      (logs/traces.jsonl)
 *   npm run report:failures -- logs/traces.eval.jsonl
 * A turn can land in several categories; zero-hit categories are not listed. No hard-coded counts.
 */
import 'dotenv/config'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadLatencyConfig } from '../server/latency.ts'
import { HUMAN_CONFIDENCE_THRESHOLD } from '../server/router.ts'
import type { TurnTrace } from '../server/tracing.ts'
import { argFiles, mdTable, readTurns } from './trace-utils.mts'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const files = argFiles(process.argv.slice(2), [path.join(ROOT, 'logs', 'traces.jsonl')])
const budget = loadLatencyConfig().budgetMs
const isTimeout = (s?: string | null) => /timeout|timed out|abort/i.test(s ?? '')

/** Taxonomy: trace fields -> category names. */
function categorize(t: TurnTrace): string[] {
  const cats: string[] = []
  const bad = (t.spans ?? []).filter((s) => !s.ok)
  for (const s of bad) cats.push(`${isTimeout(s.error) ? 'timeout' : 'error'}:${s.name}`)
  if (t.error && bad.length === 0) cats.push(isTimeout(t.error) ? 'timeout:turn' : 'error:turn')
  for (const tc of t.tool_calls ?? []) if (!tc.ok) cats.push(`tool_error:${tc.tool}`)
  if (t.fallback) cats.push(`fallback:${t.fallback.reason}`)
  if (t.route === 'human' || t.handoff) cats.push(`handoff:${t.router?.reason ?? t.outcome ?? 'unknown'}`)
  if (t.router && t.router.confidence < HUMAN_CONFIDENCE_THRESHOLD) cats.push('low_confidence')
  if (t.failed_clarification) cats.push('failed_clarification')
  if (t.intent === 'unknown') cats.push('unknown_intent_fallback_reply')
  if (t.reply_chars === 0) cats.push('empty_answer')
  if (typeof t.ttfa_ms === 'number' && t.ttfa_ms > budget) cats.push('over_latency_budget')
  return cats
}

const turns = readTurns(files)
const byCat = new Map<string, TurnTrace[]>()
let failedTurns = 0
for (const t of turns) {
  const cats = categorize(t)
  if (cats.length) failedTurns++
  for (const c of cats) byCat.set(c, [...(byCat.get(c) ?? []), t])
}
const pct = (n: number) => `${Math.round((n / turns.length) * 100)}%`

const lines: string[] = ['# Failure report', '', `Generated: ${new Date().toISOString()}`, '']
lines.push(`Sources: ${files.map((f) => path.relative(ROOT, f)).join(', ')}`, '')
if (turns.length === 0) {
  lines.push('No turn traces found. Categories will appear once real or test calls have been traced.')
} else {
  lines.push(`Turns analysed: **${turns.length}** - turns with >=1 failure signal: **${failedTurns}** (${pct(failedTurns)})`, '')
  const rows = [...byCat]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([cat, ts]) => [cat, ts.length, pct(ts.length), new Set(ts.map((t) => t.call_id)).size, ts.slice(0, 3).map((t) => `${t.trace_id.slice(0, 8)}#${t.turn_id}`).join(', ')])
  lines.push(rows.length ? mdTable(['Category', 'turns', '% of turns', 'calls', 'example trace#turn'], rows) : 'No failure signals found.', '')
  lines.push(
    '## How categories are derived',
    '',
    '- `error:<span>` / `timeout:<span>`: a span recorded `ok: false` (timeout if the error says so)',
    '- `tool_error:<tool>`: a tool call recorded `ok: false`',
    '- `fallback:<reason>`: latency/token ladder fired (budget_exceeded, token_cap, llm_timeout, llm_error)',
    '- `handoff:<reason>`: routed to a human, with the router reason',
    `- \`low_confidence\`: router confidence < ${HUMAN_CONFIDENCE_THRESHOLD}`,
    '- `failed_clarification`: agent re-asked and captured nothing new',
    '- `unknown_intent_fallback_reply`: engine answered with its generic "what do you need?" line',
    '- `empty_answer`: reply had 0 characters',
    `- \`over_latency_budget\`: measured TTFA > ${budget} ms`,
  )
}

const out = path.join(ROOT, 'metrics', 'failures.md')
mkdirSync(path.dirname(out), { recursive: true })
writeFileSync(out, lines.join('\n') + '\n', 'utf8')
console.log(lines.join('\n'))
console.log(`\nWrote ${path.relative(ROOT, out)}`)
