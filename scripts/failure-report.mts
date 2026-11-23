/**
 * Failure taxonomy built automatically from traces (+ replay expectation failures) -> metrics/failures.md
 *   npm run report:failures                         logs/traces.jsonl + latest replay outputs (if present)
 *   npm run report:failures -- logs/traces.eval.jsonl
 *   npm run report:failures -- --require-coverage   exit 1 if an observed category has no replay test
 * Categories come only from fields present in the traces (scripts/taxonomy.mts). Each category
 * prefix maps to replay tests in evals/taxonomy.json. A turn can land in several categories.
 */
import 'dotenv/config'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadLatencyConfig } from '../server/latency.ts'
import { HUMAN_CONFIDENCE_THRESHOLD } from '../server/router.ts'
import { categorize, categorizeExpectationError, prefixOf } from './taxonomy.mts'
import { argFiles, mdTable, readJsonl, readTurns } from './trace-utils.mts'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const replayDirs = ['latest', 'faults'].map((d) => path.join(ROOT, 'metrics', 'replay', d))
const defaults = [path.join(ROOT, 'logs', 'traces.jsonl'), ...replayDirs.map((d) => path.join(d, 'traces.jsonl'))].filter(existsSync)
const files = argFiles(argv, defaults)
const resultFiles = argv.some((a) => !a.startsWith('--')) ? [] : replayDirs.map((d) => path.join(d, 'results.jsonl')).filter(existsSync)
const budget = loadLatencyConfig().budgetMs
const coverage = JSON.parse(readFileSync(path.join(ROOT, 'evals', 'taxonomy.json'), 'utf8')) as Record<string, string[] | string>

const turns = readTurns(files)
const byCat = new Map<string, string[]>()
let failedTurns = 0
for (const t of turns) {
  const cats = categorize(t, budget)
  if (cats.length) failedTurns++
  for (const c of cats) byCat.set(c, [...(byCat.get(c) ?? []), `${t.trace_id.slice(0, 8)}#${t.turn_id}`])
}
// Replay expectation failures (wrong route, missed hand-off, ...)
let expectationFailures = 0
for (const f of resultFiles) {
  for (const r of readJsonl<{ id: string; ok: boolean; errors: string[] }>(f)) {
    for (const e of r.errors ?? []) {
      expectationFailures++
      const c = categorizeExpectationError(e)
      byCat.set(c, [...(byCat.get(c) ?? []), `${path.basename(path.dirname(f))}/${r.id}`])
    }
  }
}
const pct = (n: number) => `${Math.round((n / Math.max(1, turns.length)) * 100)}%`
const testsFor = (cat: string) => {
  const t = coverage[prefixOf(cat)]
  return Array.isArray(t) ? t : []
}

const lines: string[] = ['# Failure report', '', `Generated: ${new Date().toISOString()}`, '']
lines.push(`Sources: ${[...files, ...resultFiles].map((f) => path.relative(ROOT, f)).join(', ') || 'none'}`, '')
const uncovered = [...byCat.keys()].filter((c) => testsFor(c).length === 0)
if (turns.length === 0 && expectationFailures === 0) {
  lines.push('No turn traces found. Run `npm run replay` (synthetic) or trace real calls first.')
} else {
  lines.push(`Turns analysed: **${turns.length}** - turns with >=1 failure signal: **${failedTurns}** (${pct(failedTurns)}); replay expectation failures: **${expectationFailures}**`, '')
  const rows = [...byCat]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([cat, ex]) => [cat, ex.length, pct(ex.length), ex.slice(0, 3).join(', '), testsFor(cat).map((t) => `\`${t}\``).join('<br>') || '**NONE**'])
  lines.push(rows.length ? mdTable(['Category', 'count', '% of turns', 'examples', 'replay test(s) that must keep passing'], rows) : 'No failure signals found.', '')
  lines.push(uncovered.length ? `**Uncovered categories:** ${uncovered.join(', ')}` : 'Every observed category has at least one replay test (tests/replay-taxonomy.test.ts).', '')
  lines.push(
    '## How categories are derived (scripts/taxonomy.mts)',
    '',
    '- `error:<span>` / `timeout:<span>`: a span recorded `ok: false` (timeout if the error says so)',
    '- `tool_error:<tool>` / `tool_misuse:<tool>`: tool failed / tool args failed schema validation',
    '- `fallback:<reason>`: latency/token ladder fired (budget_exceeded, token_cap, llm_timeout, llm_error)',
    '- `handoff:<reason>`: routed to a human, with the router reason',
    `- \`low_confidence\`: router confidence < ${HUMAN_CONFIDENCE_THRESHOLD}`,
    '- `failed_clarification`: agent re-asked and captured nothing new',
    '- `unknown_intent_fallback_reply`: engine answered with its generic "what do you need?" line',
    '- `empty_answer`: reply had 0 characters',
    `- \`over_latency_budget\`: TTFA (or server first-audio-ready) > ${budget} ms; \`filler_first\`: filler went out first`,
    '- `ungrounded_answer:<price|time>` / `pii_leak:<phone|email>` / `guard_blocked` / `long_reply:<path>`: guard findings',
    '- `token_cap`: per-call token cap hit on this turn',
    '- `wrong_route:<expected>` / `missed_handoff` / `expectation_failed`: replay expectation failures',
    '',
    'Note: synthetic replay runs (especially `--faults`) contain failures on purpose; read categories with their source.',
  )
}

const out = path.join(ROOT, 'metrics', 'failures.md')
mkdirSync(path.dirname(out), { recursive: true })
writeFileSync(out, lines.join('\n') + '\n', 'utf8')
console.log(lines.join('\n'))
console.log(`\nWrote ${path.relative(ROOT, out)}`)
if (argv.includes('--require-coverage') && uncovered.length) {
  console.error(`TAXONOMY_COVERAGE_FAIL: ${uncovered.join(', ')}`)
  process.exit(1)
}
