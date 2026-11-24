/**
 * Response-agent probe: 30 varied caller questions straight into
 * retrieval -> response agent -> guard (no router / rule engine in front), to
 * measure grounding and wrong answers of the REAL model. Opt-in, not a CI gate:
 *   npx tsx scripts/llm-probe.mts                    (mock, offline)
 *   LLM_PROVIDER=groq LLM_API_KEY=... npx tsx scripts/llm-probe.mts --label=groq
 * Checks come from the business config (evals/llm-probe.jsonl): `must` = the
 * config fact must be present, `must_not` = contradicts the config, `abstain` =
 * the config has no answer so the agent must defer to the team. Every answer is
 * also written out for a manual read. Never logs request headers or keys.
 */
import 'dotenv/config'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mmDentalBusiness } from '../src/businesses/mm-dental.ts'
import { retrieve } from '../server/agents/retrieval.ts'
import { runResponseAgent } from '../server/agents/response.ts'
import { guardReply } from '../server/agents/guard.ts'
import { loadLlmClient, type RemoteLlmClient } from '../server/llm.ts'
import { readJsonl } from './trace-utils.mts'

interface ProbeCase { id: string; q: string; expect: 'answer' | 'abstain'; must?: string[]; must_not?: string[] }

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flag = (n: string) => argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1]
const label = flag('label') ?? 'probe'
const paceMs = Number(flag('pace-ms') ?? 3100)
const cases = readJsonl<ProbeCase>(path.join(ROOT, 'evals', 'llm-probe.jsonl'))
const llm = loadLlmClient({ LLM_MAX_REQUESTS: '40', ...process.env })
const remote = 'stats' in llm ? (llm as RemoteLlmClient) : null
/** Heuristic only; every answer is also read by hand. */
const ABSTAIN = /\b(team|confirm|check|not sure|don'?t have|do not have|can'?t say|unable)\b/i
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : 0
}

const rows: Array<Record<string, unknown>> = []
for (const [i, c] of cases.entries()) {
  if (remote && i > 0) await sleep(paceMs)
  const r = retrieve(mmDentalBusiness, c.q)
  const t0 = performance.now()
  let text = ''
  let raw = ''
  let citations: string[] = []
  let ttft = 0
  let error: string | null = null
  let tokens = 0
  try {
    const out = await runResponseAgent(llm, { business: mmDentalBusiness.name, question: c.q, passages: r.passages })
    text = out.text
    raw = out.rawText
    citations = out.citations
    ttft = out.ttftMs
    tokens = out.usage.prompt + out.usage.completion
  } catch (e) {
    error = e instanceof Error ? e.message.slice(0, 200) : String(e)
    if (remote && /429/.test(error)) await sleep(Math.max(remote.stats().lastRetryAfterMs, 10_000))
  }
  const totalMs = Math.round(performance.now() - t0)
  const cited = r.passages.filter((p) => citations.includes(p.id))
  const g = guardReply({ text, source: 'llm', grounding: (cited.length ? cited : r.passages).map((p) => p.text), allowedContacts: mmDentalBusiness.locations.map((l) => l.phone), hours: mmDentalBusiness.locations, callerText: c.q })
  const spoken = g.blocked ? g.text : text
  const missing = (c.must ?? []).filter((m) => !new RegExp(m, 'i').test(spoken))
  const contradicts = (c.must_not ?? []).filter((m) => new RegExp(m, 'i').test(spoken))
  const abstained = ABSTAIN.test(spoken)
  const assertedWithoutSource = c.expect === 'abstain' && !abstained
  rows.push({
    id: c.id, q: c.q, expect: c.expect, answer: spoken, raw_model: raw, error, citations, top_passage: r.passages[0]?.id ?? null,
    guard_blocked: g.blocked, guard_violations: g.violations.map((v) => v.kind), ttft_ms: ttft, total_ms: totalMs, tokens,
    missing_fact: missing, contradicts, abstained, asserted_without_source: assertedWithoutSource,
    // wrong = a contradiction the caller would HEAR; a guard block is counted separately (caller hears the safe line)
    auto_wrong: !error && !g.blocked && (contradicts.length > 0 || assertedWithoutSource),
  })
  console.log(`${error ? 'ERR ' : rows.at(-1)!.auto_wrong ? 'WRONG' : missing.length ? 'MISS' : 'ok  '} ${c.id}: ${error ?? spoken}`)
}

const ok = rows.filter((r) => !r.error)
const answerable = ok.filter((r) => r.expect === 'answer')
const summary = {
  label, generated: new Date().toISOString(), provider: llm.provider, model: llm.primaryModel, note: llm.note,
  cases: rows.length, errors: rows.length - ok.length,
  auto_wrong: ok.filter((r) => r.auto_wrong).length,
  guard_blocked: ok.filter((r) => r.guard_blocked).length,
  contradictions: ok.filter((r) => (r.contradicts as string[]).length).length,
  asserted_without_source: ok.filter((r) => r.asserted_without_source).length,
  answerable: answerable.length,
  answerable_with_fact: answerable.filter((r) => !(r.missing_fact as string[]).length).length,
  abstain_cases: ok.filter((r) => r.expect === 'abstain').length,
  abstained_correctly: ok.filter((r) => r.expect === 'abstain' && r.abstained).length,
  cited: ok.filter((r) => (r.citations as string[]).length).length,
  ttft_ms: { n: ok.length, p50: pct(ok.map((r) => r.ttft_ms as number), 50), p95: pct(ok.map((r) => r.ttft_ms as number), 95) },
  total_ms: { p50: pct(ok.map((r) => r.total_ms as number), 50), p95: pct(ok.map((r) => r.total_ms as number), 95) },
  tokens_per_answer: ok.length ? Math.round(ok.reduce((a, r) => a + (r.tokens as number), 0) / ok.length) : 0,
  llm_stats: remote ? remote.stats() : null,
}
const dir = path.join(ROOT, 'metrics', 'probe', label)
mkdirSync(dir, { recursive: true })
writeFileSync(path.join(dir, 'answers.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2))
console.log(JSON.stringify(summary, null, 2))
