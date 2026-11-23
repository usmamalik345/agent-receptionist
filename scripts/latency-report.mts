/**
 * p50/p95 latency report from real traces -> metrics/report.md
 *   npm run report:latency                          (logs/traces.jsonl)
 *   npm run report:latency -- path/a.jsonl --include-eval
 * Only numbers present in the traces are reported; missing fields show n/a.
 */
import 'dotenv/config'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadLatencyConfig } from '../server/latency.ts'
import type { TurnTrace } from '../server/tracing.ts'
import { argFiles, fmt, mdTable, percentile, readTurns } from './trace-utils.mts'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const files = argFiles(argv, [
  path.join(ROOT, 'logs', 'traces.jsonl'),
  ...(argv.includes('--include-eval') ? [path.join(ROOT, 'logs', 'traces.eval.jsonl')] : []),
])
const cfg = loadLatencyConfig()
const turns = readTurns(files)

const engineMs = (t: TurnTrace) => t.spans.find((s) => s.name === 'engine' || s.name === 'llm')?.duration_ms
const nums = (sub: TurnTrace[], pick: (t: TurnTrace) => number | null | undefined) =>
  sub.map(pick).filter((x): x is number => typeof x === 'number')
const METRICS: Array<[string, (t: TurnTrace) => number | null | undefined]> = [
  ['Time to first audio (end of speech -> first bot audio)', (t) => t.ttfa_ms],
  ['Endpointing wait (last STT result -> submit)', (t) => t.endpointing_ms],
  ['First-audio text ready (server)', (t) => t.first_audio_ready_ms],
  ['Engine / LLM response', engineMs],
  ['LLM time to first token', (t) => t.llm_ttft_ms],
  ['TTS time to first byte', (t) => t.tts_ttfb_ms],
  ['STT', (t) => t.stt_ms],
  ['Router decision', (t) => t.router?.latency_ms],
]

const lines: string[] = ['# Latency report', '', `Generated: ${new Date().toISOString()}`, '']
lines.push(`Sources: ${files.map((f) => path.relative(ROOT, f)).join(', ')}`, '')
if (turns.length === 0) {
  lines.push('No turn traces found yet. Run with VITE_TRACE=1 (browser) or /api/agent/turn, make test calls, then re-run.')
} else {
  const calls = new Set(turns.map((t) => t.call_id))
  const bySource = new Map<string, number>()
  for (const t of turns) bySource.set(t.source, (bySource.get(t.source) ?? 0) + 1)
  lines.push(`Turns: **${turns.length}** across **${calls.size}** calls (${[...bySource].map(([k, v]) => `${k}: ${v}`).join(', ')})`, '')
  const ttfa = nums(turns, (t) => t.ttfa_ms)
  const over = ttfa.filter((x) => x > cfg.budgetMs).length
  lines.push(
    `Budget: first audio <= **${cfg.budgetMs} ms** (LATENCY_BUDGET_FIRST_AUDIO_MS). Measured TTFA turns: ${ttfa.length}; over budget: ${ttfa.length ? `${over} (${Math.round((over / ttfa.length) * 100)}%)` : 'n/a'}`,
    '',
  )
  const rows = METRICS.map(([label, pick]) => {
    const v = nums(turns, pick)
    return [label, v.length, fmt(percentile(v, 50), ' ms'), fmt(percentile(v, 95), ' ms'), fmt(v.length ? Math.max(...v) : null, ' ms')]
  })
  lines.push('## All turns', '', mdTable(['Metric', 'n', 'p50', 'p95', 'max'], rows), '')

  const routes = [...new Set(turns.map((t) => t.route ?? 'none'))]
  const routeRows = routes.map((r) => {
    const sub = turns.filter((t) => (t.route ?? 'none') === r)
    const a = nums(sub, (t) => t.ttfa_ms)
    const e = nums(sub, engineMs)
    return [r, sub.length, fmt(percentile(a, 50), ' ms'), fmt(percentile(a, 95), ' ms'), fmt(percentile(e, 50), ' ms'), fmt(percentile(e, 95), ' ms')]
  })
  lines.push('## By route', '', mdTable(['Route', 'turns', 'TTFA p50', 'TTFA p95', 'engine p50', 'engine p95'], routeRows), '')

  const withTokens = turns.filter((t) => t.tokens)
  lines.push('## Tokens', '')
  if (withTokens.length === 0) {
    lines.push('No token usage in traces (current responder is the deterministic rule engine; no LLM tokens).', '')
  } else {
    const total = (t: TurnTrace) => t.tokens!.prompt + t.tokens!.completion
    const perCall = new Map<string, number>()
    for (const t of withTokens) perCall.set(t.call_id, (perCall.get(t.call_id) ?? 0) + total(t))
    const sum = withTokens.reduce((a, t) => a + total(t), 0)
    lines.push(`Avg tokens/turn: ${fmt(sum / withTokens.length)}; avg tokens/call: ${fmt(sum / perCall.size)}`, '')
  }

  const fb = new Map<string, number>()
  for (const t of turns) if (t.fallback) fb.set(`${t.fallback.reason} -> ${t.fallback.step}`, (fb.get(`${t.fallback.reason} -> ${t.fallback.step}`) ?? 0) + 1)
  lines.push('## Fallbacks', '', fb.size ? mdTable(['Reason -> step', 'count'], [...fb]) : 'None recorded.', '')
}

const out = path.join(ROOT, 'metrics', 'report.md')
mkdirSync(path.dirname(out), { recursive: true })
writeFileSync(out, lines.join('\n') + '\n', 'utf8')
console.log(lines.join('\n'))
console.log(`\nWrote ${path.relative(ROOT, out)}`)
