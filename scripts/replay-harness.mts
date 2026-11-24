/**
 * 100-call replay harness (offline, mock LLM provider, no network, no keys).
 *   npm run replay                      clean run -> metrics/replay/latest/
 *   npm run replay -- --faults          deterministic fault injection (slow LLM, hanging tool)
 *   npm run replay -- --label=pr-123    output to metrics/replay/pr-123/
 *   npm run replay -- --gate            exit 1 if eval pass < EVAL_THRESHOLD, safety < 100%, or p95 first-audio > budget
 *   npm run replay -- --write-baseline  also write evals/replay/baseline.decisions.jsonl (for decision-diff in CI)
 *   --provider=env    use the LLM from env (LLM_PROVIDER/LLM_API_KEY) instead of the mock. Opt-in only; CI never sets it.
 *                     Paces model requests (--pace-ms, default 3100 = <=20/min), honours 429 retry-after,
 *                     and stops calling the model after LLM_MAX_REQUESTS (default 150 in this mode).
 *   --no-cache        disable the response cache (every retrieval turn calls the model; for TTFT sampling)
 *   --limit=N         only the first N calls
 *
 * Measured here (real wall-clock on this machine): server-side time from transcript to
 * first audio ready (reply or filler), and per-stage span times (triage+router, retrieval,
 * model/engine, tool). NOT measured: STT, real LLM TTFT, TTS, network - those need real
 * audio + a real provider. Token counts on the mock are estimates (~4 chars/token).
 */
import 'dotenv/config'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AgentRuntime } from '../server/agentTurn.ts'
import { llmCostUsd } from '../server/cost.ts'
import { loadLatencyConfig } from '../server/latency.ts'
import type { ResponseCache } from '../server/cache.ts'
import { abortableSleep, createMockClient, loadLlmClient, type LlmClient, type RemoteLlmClient } from '../server/llm.ts'
import type { RouterDecision } from '../server/router.ts'
import type { ToolFn } from '../server/tools.ts'
import type { TurnTrace } from '../server/tracing.ts'
import { checkTurn, type EvalCase } from './expect.mts'
import { fmt, mdTable, percentile, readJsonl } from './trace-utils.mts'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flag = (n: string) => argv.includes(`--${n}`)
const opt = (n: string) => argv.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=')
const faults = flag('faults')
const label = opt('label') ?? (faults ? 'faults' : 'latest')
const callsFile = opt('calls') ?? path.join(ROOT, 'evals', 'replay', 'calls.jsonl')
const outDir = path.join(ROOT, 'metrics', 'replay', label)
const threshold = Number(process.env.EVAL_THRESHOLD || 0.9)
const config = loadLatencyConfig()

const realProvider = opt('provider') === 'env'
const paceMs = Number(opt('pace-ms') ?? 3100)
const noCache = flag('no-cache')
const limit = opt('limit') ? Number(opt('limit')) : undefined
const calls = readJsonl<EvalCase>(callsFile).slice(0, limit)
if (!calls.length) {
  console.error(`no calls in ${callsFile} - run npm run replay:fixtures`)
  process.exit(1)
}

// ---- providers: always the offline mock here; --faults slows every 4th model call past the budget ----
const mock = createMockClient()
let llmCalls = 0
const remote = realProvider ? (loadLlmClient({ LLM_MAX_REQUESTS: '150', ...process.env }) as RemoteLlmClient) : null
if (realProvider && remote!.provider === 'mock') {
  console.error(`--provider=env but the env selects the mock (${remote!.note}); refusing to label a mock run as real`)
  process.exit(1)
}
const llm: LlmClient = remote ?? faults
  ? {
      ...mock,
      note: 'mock + injected latency',
      complete: async (req) => {
        llmCalls++
        if (req.tier !== 'small' && llmCalls % 4 === 0) await abortableSleep(config.budgetMs * 2, req.signal)
        return mock.complete(req)
      },
    }
  : mock
let ticketCalls = 0
const ticketTool: ToolFn<string> = async (args, ctx) => {
  ticketCalls++
  if (faults && ticketCalls % 5 === 0) {
    ctx.progress('ticket queued') // progress then stall: deadline must stay armed
    return new Promise<never>(() => {})
  }
  return `ticket:${String(args.priority)}`
}

const traces: TurnTrace[] = []
const decisions: Array<RouterDecision & { fixture: string; turn_index: number }> = []
let current = { fixture: '', turn: 0 }
const nullCache: ResponseCache = {
  key: (t, b, v) => `${b}|${v}|${t}`,
  get: async () => null,
  set: async () => {},
  stats: () => ({ hits: 0, misses: 0, sets: 0, errors: 0, backend: 'memory' }),
  resetStats: () => {},
}
const agent = new AgentRuntime({
  config,
  ...(noCache ? { cache: nullCache } : {}),
  enforceRouter: true,
  stdout: false,
  llm,
  tools: { create_ticket: ticketTool },
  toolTimeoutMs: Number(process.env.TOOL_TIMEOUT_MS || 1000),
  traceSink: (t) => traces.push(t as TurnTrace),
  decisionSink: (d) => decisions.push({ ...(d as RouterDecision), fixture: current.fixture, turn_index: current.turn }),
})

interface TurnRow {
  fixture: string
  scenario: string
  i: number
  ok: boolean
  errors: string[]
  routeExpected?: string
  route: string
  firstAudioMs: number
  firstAudioKind: string
  trace: TurnTrace
}
const rows: TurnRow[] = []
const callResults: Array<{ id: string; scenario: string; tags: string[]; ok: boolean; errors: string[] }> = []

let lastRequestAt = 0
const rateLimitWaits: number[] = []
const modelAnswers: Array<Record<string, unknown> & { expectation_errors: string[]; guard?: TurnTrace['guard']; ttft_ms: number | null }> = []
const t0 = Date.now()
for (const c of calls) {
  const callId = `replay-${c.id}`
  agent.start({ business: c.business ?? 'mm-dental', afterHours: c.after_hours, source: 'replay', callId })
  const errs: string[] = []
  for (const [i, turn] of c.turns.entries()) {
    current = { fixture: c.id, turn: i + 1 }
    const before = remote?.stats()
    if (remote && lastRequestAt) {
      const wait = paceMs - (Date.now() - lastRequestAt)
      if (wait > 0) await new Promise((res) => setTimeout(res, wait))
    }
    const r = await agent.turn(callId, turn.text)
    if (remote && before) {
      const after = remote.stats()
      if (after.requests > before.requests) lastRequestAt = Date.now()
      if (after.http429 > before.http429) {
        rateLimitWaits.push(after.lastRetryAfterMs)
        await new Promise((res) => setTimeout(res, after.lastRetryAfterMs))
      }
    }
    if (r.trace.agent_path === 'multi_agent') {
      modelAnswers.push({ fixture: c.id, turn: i + 1, question: turn.text, answer: r.text, citations: r.citations, guard: r.trace.guard, model: r.trace.model, ttft_ms: r.trace.llm_ttft_ms, first_audio_ms: r.firstAudioAtMs, first_audio_kind: r.trace.first_audio_kind, fallback: r.trace.fallback, cache_hit: r.cacheHit, expectation_errors: checkTurn(r, turn.expect) })
    }
    const e = checkTurn(r, turn.expect)
    errs.push(...e.map((x) => `turn ${i + 1}: ${x} :: "${r.text.slice(0, 80)}"`))
    rows.push({ fixture: c.id, scenario: c.scenario ?? c.id, i: i + 1, ok: e.length === 0, errors: e, routeExpected: turn.expect.route, route: r.route, firstAudioMs: r.firstAudioAtMs, firstAudioKind: r.trace.first_audio_kind ?? 'reply', trace: r.trace })
  }
  agent.end(callId)
  callResults.push({ id: c.id, scenario: c.scenario ?? c.id, tags: c.tags ?? [], ok: errs.length === 0, errors: errs })
}
const wallMs = Date.now() - t0

// ---- metrics ----
const pct = (n: number, d: number) => (d === 0 ? null : Math.round((n / d) * 1000) / 10)
const spanMs = (t: TurnTrace, names: string[]) => t.spans.filter((s) => names.includes(s.name)).reduce((a, s) => a + s.duration_ms, 0)
const turns = rows.length
const routed = rows.filter((r) => r.routeExpected)
const safety = callResults.filter((c) => c.tags.includes('safety'))
const modelTurns = rows.filter((r) => r.trace.agent_path === 'multi_agent')
const groundedTurns = modelTurns.filter((r) => r.trace.guard?.ok && (r.trace.citations?.length ?? 0) > 0)
const toolCalls = rows.flatMap((r) => r.trace.tool_calls)
const schemaBad = toolCalls.filter((t) => String(t.result ?? '').startsWith('schema_error'))
const cache = agent.cache.stats()
const ledger = agent.ledger.all()
const priced = ledger.filter((l) => l.unpriced === 0)
const proj = agent.prices.projection_model
const projCost = (t: TurnTrace) => (t.tokens && proj ? (llmCostUsd(agent.prices, proj, t.tokens) ?? 0) : 0)
const projPerCall = calls.length ? rows.reduce((a, r) => a + projCost(r.trace), 0) / calls.length : 0
const llmTurns = rows.filter((r) => typeof r.trace.llm_ttft_ms === 'number' && r.trace.agent_path === 'multi_agent' && !r.trace.cache_hit)
const wrongAuto = modelAnswers.filter((a) => a.guard?.blocked || a.expectation_errors.length > 0)
const engineGuardWarn = rows.filter((r) => r.trace.agent_path === 'engine' && r.trace.guard && !r.trace.guard.ok)

const summary = {
  generated: new Date().toISOString(),
  label,
  cache_disabled: noCache,
  llm_requests: remote ? remote.stats() : null,
  rate_limit_waits_ms: rateLimitWaits,
  llm_ttft_ms: { samples: llmTurns.length, p50: percentile(llmTurns.map((r) => r.trace.llm_ttft_ms!), 50), p95: percentile(llmTurns.map((r) => r.trace.llm_ttft_ms!), 95) },
  model_turn_first_audio_ms: { samples: modelTurns.length, p50: percentile(modelTurns.map((r) => r.firstAudioMs), 50), p95: percentile(modelTurns.map((r) => r.firstAudioMs), 95) },
  model_answers: modelAnswers.length,
  wrong_answers_auto: { count: wrongAuto.length, of: modelAnswers.length, rate: pct(wrongAuto.length, modelAnswers.length), rule: 'guard blocked OR fixture expectation failed on a model-answered turn' },
  mode: faults ? 'fault-injected (every 4th primary model call delayed 2x budget; every 5th ticket tool sends progress then stalls)' : 'clean',
  provider: `${agent.llm.provider} (${agent.llm.note})`,
  multi_agent: agent.multiAgent,
  calls: calls.length,
  turns,
  wall_ms: wallMs,
  budget_ms: config.budgetMs,
  first_audio_ready_ms: { p50: percentile(rows.map((r) => r.firstAudioMs), 50), p95: percentile(rows.map((r) => r.firstAudioMs), 95), max: Math.max(...rows.map((r) => r.firstAudioMs)) },
  first_audio_over_budget_turns: rows.filter((r) => r.firstAudioMs > config.budgetMs).length,
  filler_first_turns: rows.filter((r) => r.firstAudioKind === 'filler').length,
  stage_ms: {
    triage_router: { p50: percentile(rows.map((r) => spanMs(r.trace, ['router'])), 50), p95: percentile(rows.map((r) => spanMs(r.trace, ['router'])), 95) },
    retrieval: { p50: percentile(modelTurns.map((r) => spanMs(r.trace, ['retrieval'])), 50), p95: percentile(modelTurns.map((r) => spanMs(r.trace, ['retrieval'])), 95) },
    model_or_engine: { p50: percentile(rows.map((r) => spanMs(r.trace, ['llm', 'engine'])), 50), p95: percentile(rows.map((r) => spanMs(r.trace, ['llm', 'engine'])), 95) },
  },
  eval_pass: { passed: callResults.filter((c) => c.ok).length, total: calls.length, rate: pct(callResults.filter((c) => c.ok).length, calls.length) },
  turn_pass: { passed: rows.filter((r) => r.ok).length, total: turns, rate: pct(rows.filter((r) => r.ok).length, turns) },
  route_accuracy: { correct: routed.filter((r) => r.route === r.routeExpected).length, total: routed.length, rate: pct(routed.filter((r) => r.route === r.routeExpected).length, routed.length) },
  safety_cases: { passed: safety.filter((c) => c.ok).length, total: safety.length },
  grounded: { grounded: groundedTurns.length, model_turns: modelTurns.length, rate: pct(groundedTurns.length, modelTurns.length) },
  guard_blocked_turns: rows.filter((r) => r.trace.guard?.blocked).length,
  engine_guard_warnings: engineGuardWarn.length,
  length_warnings: rows.filter((r) => r.trace.guard?.violations.some((v) => v.kind === 'length')).length,
  tool_validity: { valid: toolCalls.length - schemaBad.length, total: toolCalls.length, rate: pct(toolCalls.length - schemaBad.length, toolCalls.length) },
  tool_failures: toolCalls.filter((t) => !t.ok && !String(t.result ?? '').startsWith('schema_error')).length,
  route_share: Object.fromEntries(['rule', 'tool', 'retrieval', 'human'].map((k) => [k, pct(rows.filter((r) => r.route === k).length, turns)])),
  handoff: { turns: rows.filter((r) => r.trace.handoff).length, turn_rate: pct(rows.filter((r) => r.trace.handoff).length, turns), calls: new Set(rows.filter((r) => r.trace.handoff).map((r) => r.fixture)).size, call_rate: pct(new Set(rows.filter((r) => r.trace.handoff).map((r) => r.fixture)).size, calls.length) },
  cache: { ...cache, hit_rate_of_lookups: pct(cache.hits, cache.hits + cache.misses), hit_rate_of_turns: pct(rows.filter((r) => r.trace.cache_hit).length, turns) },
  fallback: { turns: rows.filter((r) => r.trace.fallback).length, rate: pct(rows.filter((r) => r.trace.fallback).length, turns), small_model_turns: rows.filter((r) => r.trace.fallback?.step === 'smaller_model').length, small_model_rate: pct(rows.filter((r) => r.trace.fallback?.step === 'smaller_model').length, turns) },
  token_cap: { calls_hit: ledger.filter((l) => l.capHits > 0).length, rate: pct(ledger.filter((l) => l.capHits > 0).length, calls.length), cap: config.maxTokensPerCall },
  tokens: { per_call_avg: Math.round(ledger.reduce((a, l) => a + l.tokens, 0) / Math.max(1, ledger.length)), estimated: true },
  cost: {
    per_call_usd: priced.length ? priced.reduce((a, l) => a + l.cost, 0) / priced.length : null,
    note: `estimate from the dated price table (as_of ${agent.prices.as_of}) for ${agent.llm.primaryModel}/${agent.llm.smallModel}; free-plan usage is billed $0`,
    projection: { model: proj ?? null, per_call_usd: projPerCall, note: 'PROJECTION only: mock token estimates priced at the projection model paid rate; not a measurement' },
  },
}

// ---- outputs ----
mkdirSync(outDir, { recursive: true })
writeFileSync(path.join(outDir, 'traces.jsonl'), traces.map((t) => JSON.stringify(t)).join('\n') + '\n')
const slimDecisions = decisions.map((d) => ({
  fixture: d.fixture, turn_index: d.turn_index, call_id: d.call_id, turn_id: d.turn_id, route: d.route, reason: d.reason,
  matched_rule: d.matched_rule, intent: d.intent, confidence: d.confidence, risk: d.triage?.risk ?? null, fallback_reason: d.fallback_reason ?? null,
}))
writeFileSync(path.join(outDir, 'decisions.jsonl'), slimDecisions.map((d) => JSON.stringify(d)).join('\n') + '\n')
writeFileSync(path.join(outDir, 'results.jsonl'), callResults.map((c) => JSON.stringify(c)).join('\n') + '\n')
writeFileSync(path.join(outDir, 'model_answers.jsonl'), modelAnswers.map((a) => JSON.stringify(a)).join('\n') + (modelAnswers.length ? '\n' : ''))
writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
if (flag('write-baseline')) {
  writeFileSync(path.join(ROOT, 'evals', 'replay', 'baseline.decisions.jsonl'), slimDecisions.map((d) => JSON.stringify(d)).join('\n') + '\n')
}

const S = summary
const md = [
  `# Replay harness - ${label}`,
  '',
  `Generated ${S.generated}. **${realProvider ? 'Live replay (real model API over the network, from cloud box)' : 'Offline replay'} on the ${S.provider} provider${noCache ? ', response cache disabled' : ''}, ${S.calls} synthetic calls / ${S.turns} turns** from \`${path.relative(ROOT, callsFile)}\`. Mode: ${S.mode}.`,
  '',
  realProvider
    ? 'Timings are real wall-clock on this machine: transcript in -> first audio text ready, including the real model API round trip (non-cached model turns). STT, TTS and caller audio are not part of this number. Model TTFT = request start -> first streamed answer token.'
    : 'Timings are real wall-clock on this machine for the server pipeline only (transcript in -> first audio text ready). STT, real-LLM TTFT, TTS and network are not part of this number.',
  '',
  mdTable(['Metric', 'Value'], [
    ['Eval pass (calls)', `${S.eval_pass.passed}/${S.eval_pass.total} = ${S.eval_pass.rate}%`],
    ['Turn pass', `${S.turn_pass.passed}/${S.turn_pass.total} = ${S.turn_pass.rate}%`],
    ['Route accuracy (labelled turns)', `${S.route_accuracy.correct}/${S.route_accuracy.total} = ${S.route_accuracy.rate}%`],
    ['Safety cases (emergency / hand-off / off-topic)', `${S.safety_cases.passed}/${S.safety_cases.total}`],
    ['Grounded model answers (guard ok + citation)', `${S.grounded.grounded}/${S.grounded.model_turns} = ${S.grounded.rate}%`],
    ['Tool-call schema validity', `${S.tool_validity.valid}/${S.tool_validity.total} = ${S.tool_validity.rate}%`],
    ['First audio ready p50 / p95 / max', `${fmt(S.first_audio_ready_ms.p50, ' ms', 2)} / ${fmt(S.first_audio_ready_ms.p95, ' ms', 2)} / ${S.first_audio_ready_ms.max} ms (budget ${S.budget_ms} ms)`],
    ['Turns over budget / filler-first turns', `${S.first_audio_over_budget_turns} / ${S.filler_first_turns}`],
    ['Model TTFT p50 / p95 (non-cached model turns)', `${fmt(S.llm_ttft_ms.p50, ' ms')} / ${fmt(S.llm_ttft_ms.p95, ' ms')} (n=${S.llm_ttft_ms.samples})`],
    ['First audio ready on model turns p50 / p95', `${fmt(S.model_turn_first_audio_ms.p50, ' ms')} / ${fmt(S.model_turn_first_audio_ms.p95, ' ms')} (n=${S.model_turn_first_audio_ms.samples})`],
    ['Wrong answers (auto: guard block or expectation fail)', `${S.wrong_answers_auto.count}/${S.wrong_answers_auto.of}`],
    ['Model requests / 429s / tokens (prompt+completion)', S.llm_requests ? `${S.llm_requests.requests} / ${S.llm_requests.http429} / ${S.llm_requests.promptTokens}+${S.llm_requests.completionTokens}` : 'mock (no remote requests)'],
    ['Triage + router p50 / p95', `${fmt(S.stage_ms.triage_router.p50, ' ms', 2)} / ${fmt(S.stage_ms.triage_router.p95, ' ms', 2)}`],
    ['Retrieval p50 / p95 (model turns)', `${fmt(S.stage_ms.retrieval.p50, ' ms', 2)} / ${fmt(S.stage_ms.retrieval.p95, ' ms', 2)}`],
    ['Model-or-engine span p50 / p95', `${fmt(S.stage_ms.model_or_engine.p50, ' ms', 2)} / ${fmt(S.stage_ms.model_or_engine.p95, ' ms', 2)}`],
    ['Route share rule / tool / retrieval / human', `${S.route_share.rule}% / ${S.route_share.tool}% / ${S.route_share.retrieval}% / ${S.route_share.human}%`],
    ['Hand-off (turns / calls)', `${S.handoff.turn_rate}% / ${S.handoff.call_rate}%`],
    ['Cache hit rate (of lookups / of all turns)', `${S.cache.hit_rate_of_lookups}% / ${S.cache.hit_rate_of_turns}% (${S.cache.hits} hits, ${S.cache.misses} misses, ${S.cache.backend})`],
    ['Fallback turns / small-model fallback', `${S.fallback.rate}% / ${S.fallback.small_model_rate}%`],
    ['Calls hitting token cap', `${S.token_cap.calls_hit}/${S.calls} = ${S.token_cap.rate}% (cap ${S.token_cap.cap})`],
    ['Tokens per call (estimated)', String(S.tokens.per_call_avg)],
    ['Cost per call (price table)', S.cost.per_call_usd == null ? 'n/a' : `$${S.cost.per_call_usd.toFixed(6)}`],
    [`Cost per call PROJECTION (${S.cost.projection.model})`, `$${S.cost.projection.per_call_usd.toFixed(6)} - estimate, not measured`],
    ['Guard blocked / engine guard warnings / replies over length cap', `${S.guard_blocked_turns} / ${S.engine_guard_warnings} / ${S.length_warnings}`],
  ]),
  '',
  '## Failed calls',
  '',
  ...(callResults.filter((c) => !c.ok).length ? callResults.filter((c) => !c.ok).map((c) => `- ${c.id}: ${c.errors.join('; ')}`) : ['None.']),
  '',
]
writeFileSync(path.join(outDir, 'report.md'), md.join('\n'))
console.log(md.join('\n'))
console.log(`\nWrote ${path.relative(ROOT, outDir)}/{summary.json,report.md,traces.jsonl,decisions.jsonl,results.jsonl}`)

if (flag('gate')) {
  const fails: string[] = []
  if ((S.eval_pass.rate ?? 0) < threshold * 100) fails.push(`eval pass ${S.eval_pass.rate}% < ${threshold * 100}%`)
  if (S.safety_cases.passed !== S.safety_cases.total) fails.push(`safety ${S.safety_cases.passed}/${S.safety_cases.total}`)
  if ((S.first_audio_ready_ms.p95 ?? Infinity) > config.budgetMs) fails.push(`p95 first audio ${S.first_audio_ready_ms.p95} > ${config.budgetMs}`)
  if (fails.length) {
    console.error(`REPLAY_GATE_FAIL: ${fails.join(', ')}`)
    process.exit(1)
  }
  console.log('REPLAY_GATE_PASS')
}
