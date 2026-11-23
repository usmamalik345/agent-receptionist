/**
 * Per-turn token + cost accounting from config/llm-prices.json (dated config, not hard-coded).
 * cost_turn = prompt * in_rate + completion * out_rate (+ STT/TTS/transport when rates are set;
 * they are null in the shipped table, so those parts are reported as "not priced").
 * Unknown model -> cost null (never guessed).
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export interface ModelPrice {
  input_per_1m: number
  output_per_1m: number
  source?: string
}
export interface PriceTable {
  as_of: string
  models: Record<string, ModelPrice>
  projection_model?: string
  stt_per_minute: number | null
  tts_per_1k_chars: number | null
  transport_per_minute: number | null
}

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_PRICE_FILE = path.join(ROOT, 'config', 'llm-prices.json')

export function loadPriceTable(file = process.env.LLM_PRICE_FILE || DEFAULT_PRICE_FILE): PriceTable {
  return JSON.parse(readFileSync(file, 'utf8')) as PriceTable
}

export interface TokenCount {
  prompt: number
  completion: number
}

export function llmCostUsd(table: PriceTable, model: string, tokens: TokenCount | null): number | null {
  if (!tokens) return 0
  const p = table.models[model]
  if (!p) return null
  return (tokens.prompt * p.input_per_1m + tokens.completion * p.output_per_1m) / 1_000_000
}

export function turnCostUsd(
  table: PriceTable,
  t: { model: string; tokens: TokenCount | null; sttSeconds?: number; ttsChars?: number },
): { llm: number | null; stt: number | null; tts: number | null; total: number | null } {
  const llm = llmCostUsd(table, t.model, t.tokens)
  const stt = table.stt_per_minute == null || t.sttSeconds == null ? null : (t.sttSeconds / 60) * table.stt_per_minute
  const tts = table.tts_per_1k_chars == null || t.ttsChars == null ? null : (t.ttsChars / 1000) * table.tts_per_1k_chars
  return { llm, stt, tts, total: llm == null ? null : llm + (stt ?? 0) + (tts ?? 0) }
}

/** Per-call accumulator: tokens, cost, cap hits, fallback steps. */
export class CallLedger {
  private calls = new Map<string, { tokens: number; cost: number; unpriced: number; capHits: number; turns: number; small: number }>()
  private row(callId: string) {
    let r = this.calls.get(callId)
    if (!r) this.calls.set(callId, (r = { tokens: 0, cost: 0, unpriced: 0, capHits: 0, turns: 0, small: 0 }))
    return r
  }
  addTurn(callId: string, t: { tokens: TokenCount | null; costUsd: number | null; tokenCapHit: boolean; smallModel: boolean }): void {
    const r = this.row(callId)
    r.turns++
    if (t.tokens) r.tokens += t.tokens.prompt + t.tokens.completion
    if (t.costUsd == null) r.unpriced++
    else r.cost += t.costUsd
    if (t.tokenCapHit) r.capHits++
    if (t.smallModel) r.small++
  }
  get(callId: string) {
    return { ...this.row(callId) }
  }
  all() {
    return [...this.calls].map(([callId, r]) => ({ callId, ...r }))
  }
}
