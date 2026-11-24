/**
 * Accuracy evals for the dental receptionist + release gate.
 *   npm run eval        run cases, print results, write metrics/eval.md (exit 0)
 *   npm run eval:gate   same, exit 1 if pass rate < EVAL_THRESHOLD (default 0.9)
 * Offline through the real pipeline (router enforced + latency ladder + rule engine):
 * no LLM keys, no network, no WhatsApp by default (LLM_PROVIDER=mock). With LLM_PROVIDER + LLM_API_KEY
 * set in the process env the response agent calls the real model (opt-in, never in CI).
 * Traces go to logs/traces.eval.jsonl.
 */
import 'dotenv/config'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AgentRuntime } from '../server/agentTurn.ts'
import { jsonlSink } from '../server/tracing.ts'
import { checkTurn, type EvalCase } from './expect.mts'
import { mdTable, readJsonl } from './trace-utils.mts'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const gate = argv.includes('--gate')
const casesFile = argv.find((a) => !a.startsWith('--')) ?? path.join(ROOT, 'evals', 'dental.jsonl')
const threshold = Number(process.env.EVAL_THRESHOLD || 0.9)

const cases = readJsonl<EvalCase>(casesFile)
if (cases.length === 0) {
  console.error(`No eval cases in ${casesFile}`)
  process.exit(1)
}

const agent = new AgentRuntime({
  enforceRouter: true,
  stdout: false,
  traceSink: jsonlSink(path.join(ROOT, 'logs', 'traces.eval.jsonl')),
  decisionSink: () => {},
})

const results: Array<{ id: string; ok: boolean; errors: string[]; description: string }> = []
for (const c of cases) {
  const { callId } = agent.start({ business: c.business ?? 'mm-dental', afterHours: c.after_hours, source: 'eval', callId: `eval-${c.id}-${Date.now()}` })
  const errors: string[] = []
  for (const [i, turn] of c.turns.entries()) {
    try {
      const r = await agent.turn(callId, turn.text)
      for (const e of checkTurn(r, turn.expect)) errors.push(`turn ${i + 1}: ${e} :: "${r.text.slice(0, 90)}"`)
    } catch (e) {
      errors.push(`turn ${i + 1}: threw ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  agent.end(callId)
  results.push({ id: c.id, ok: errors.length === 0, errors, description: c.description })
}

const passed = results.filter((r) => r.ok).length
const rate = passed / results.length
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.id}`)
  for (const e of r.errors) console.log(`      ${e}`)
}
const llmStats = 'stats' in agent.llm ? (agent.llm as unknown as { stats(): Record<string, number> }).stats() : null
const llmLine = `LLM: ${agent.llm.provider} (${agent.llm.note})${llmStats ? ` - requests ${llmStats.requests}, 429s ${llmStats.http429}, errors ${llmStats.errors}, tokens ${llmStats.promptTokens}+${llmStats.completionTokens}` : ''}`
console.log(llmLine)
const summary = `${passed}/${results.length} = ${(rate * 100).toFixed(1)}% (threshold ${(threshold * 100).toFixed(0)}%)`
console.log(`\nAccuracy: ${summary}`)

const rows = results.map((r) => [r.id, r.ok ? 'PASS' : 'FAIL', r.description, r.errors.join('<br>').replace(/\|/g, '\\|')])
const md = ['# Eval results (dental)', '', `Generated: ${new Date().toISOString()} - cases: ${path.relative(ROOT, casesFile)}`, '', llmLine, '']
md.push(`**Accuracy: ${summary}** -> ${rate >= threshold ? 'PASS' : 'FAIL'}`, '', mdTable(['Case', 'Result', 'What it checks', 'Errors'], rows), '')
mkdirSync(path.join(ROOT, 'metrics'), { recursive: true })
writeFileSync(path.join(ROOT, 'metrics', 'eval.md'), md.join('\n'), 'utf8')

if (gate && rate < threshold) {
  console.error(`EVAL_GATE_FAIL: ${summary}`)
  process.exit(1)
}
console.log(gate ? 'EVAL_GATE_PASS' : 'EVAL_DONE')
