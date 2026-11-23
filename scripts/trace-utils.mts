/** Shared helpers for the trace report scripts (read JSONL, percentiles, md tables). */
import { existsSync, readFileSync } from 'node:fs'
import type { TurnTrace } from '../server/tracing.ts'

export function readJsonl<T = Record<string, unknown>>(file: string): T[] {
  if (!existsSync(file)) return []
  const out: T[] = []
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as T)
    } catch {
      /* skip corrupt line */
    }
  }
  return out
}

export const readTurns = (files: string[]): TurnTrace[] =>
  files.flatMap((f) => readJsonl<TurnTrace>(f)).filter((r) => r && r.type === 'turn')

/** Nearest-rank percentile. */
export function percentile(values: number[], p: number): number | null {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b)
  if (v.length === 0) return null
  return v[Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1))]
}

export const fmt = (n: number | null | undefined, unit = '', dp = 1): string => (n == null ? 'n/a' : `${Math.round(n * 10 ** dp) / 10 ** dp}${unit}`)

export const mdTable = (head: string[], rows: Array<Array<string | number>>): string =>
  [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n')

export function argFiles(argv: string[], fallback: string[]): string[] {
  const files = argv.filter((a) => !a.startsWith('--'))
  return files.length ? files : fallback
}
