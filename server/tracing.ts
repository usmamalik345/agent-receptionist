/**
 * Per-call tracing. One trace_id per call/session, one JSONL record per turn with
 * spans (router, engine/llm, tts, tool, cache, fallback...), time-to-first-audio,
 * tokens (only when a real LLM reports them - never estimated), tool calls,
 * route and errors. Appends to logs/traces.jsonl (override with TRACE_FILE).
 * Caller text is NOT stored unless TRACE_STORE_TEXT=1, and then digits are masked.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { RouterDecision } from './router.ts'
import { setDefaultSinkFactory, type Sink } from './tracingCore.ts'
export * from './tracingCore.ts'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
export const LOG_DIR = path.join(ROOT, 'logs')
export const DEFAULT_TRACE_FILE = path.join(LOG_DIR, 'traces.jsonl')
export const ROUTER_DECISIONS_FILE = path.join(LOG_DIR, 'router_decisions.jsonl')

export function appendJsonl(file: string, record: object): void {
  mkdirSync(path.dirname(file), { recursive: true })
  appendFileSync(file, JSON.stringify(record) + '\n', 'utf8')
}

export const jsonlSink = (file: string): Sink => (record) => appendJsonl(file, record)

export function defaultTraceSink(env: NodeJS.ProcessEnv = process.env): Sink {
  return jsonlSink(env.TRACE_FILE || DEFAULT_TRACE_FILE)
}

/** Router decisions go to stdout AND logs/router_decisions.jsonl. */
export function logRouterDecision(decision: RouterDecision, sink: Sink = jsonlSink(ROUTER_DECISIONS_FILE), stdout = true): void {
  if (stdout) console.log(JSON.stringify(decision))
  sink(decision)
}


setDefaultSinkFactory(() => defaultTraceSink())
