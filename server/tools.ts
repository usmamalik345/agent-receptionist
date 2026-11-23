/**
 * Tool runner with a deadline that ONLY a final result can clear.
 * Mirrors the Pipecat PR #5760 fix: a progress update (is_final=false) must not
 * disarm the timeout, so a tool that reports progress and then hangs still times out.
 * Plus schema checks for the tool calls the engine emits ("tool misuse" category).
 */
import { emptyBooking } from '../src/lib/types.ts'

export interface ToolContext {
  /** Intermediate update - does NOT clear the deadline. */
  progress(update: string): void
  signal: AbortSignal
}
export type ToolFn<T = unknown> = (args: Record<string, unknown>, ctx: ToolContext) => Promise<T>

export interface ToolRunResult<T = unknown> {
  tool: string
  ok: boolean
  result?: T
  error?: 'timeout' | string
  progress: string[]
  ms: number
}

export async function runTool<T>(name: string, fn: ToolFn<T>, args: Record<string, unknown>, opts: { timeoutMs: number }): Promise<ToolRunResult<T>> {
  const t0 = performance.now()
  const ac = new AbortController()
  const progress: string[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<ToolRunResult<T>>((resolve) => {
    timer = setTimeout(() => {
      ac.abort()
      resolve({ tool: name, ok: false, error: 'timeout', progress, ms: Math.round(performance.now() - t0) })
    }, opts.timeoutMs)
  })
  const ctx: ToolContext = {
    // Deliberately does not touch `timer`.
    progress: (u) => void progress.push(String(u).slice(0, 120)),
    signal: ac.signal,
  }
  const run = Promise.resolve()
    .then(() => fn(args, ctx))
    .then((result): ToolRunResult<T> => ({ tool: name, ok: true, result, progress, ms: Math.round(performance.now() - t0) }))
    .catch((e): ToolRunResult<T> => ({ tool: name, ok: false, error: e instanceof Error ? e.message : String(e), progress, ms: Math.round(performance.now() - t0) }))
  try {
    return await Promise.race([run, deadline])
  } finally {
    clearTimeout(timer)
  }
}

/** Tool-call argument schemas (what the engine may pass). */
const BOOKING_FIELDS = new Set(Object.keys(emptyBooking('en')))
const PRIORITIES = new Set(['normal', 'high', 'urgent'])

export function validateToolCall(tool: string, args: Record<string, unknown>): string | null {
  switch (tool) {
    case 'update_booking_fields': {
      for (const [k, v] of Object.entries(args)) {
        if (!BOOKING_FIELDS.has(k)) return `unknown field ${k}`
        if (v !== null && !['string', 'number', 'boolean'].includes(typeof v)) return `bad type for ${k}`
      }
      return null
    }
    case 'create_ticket': {
      if (typeof args.reason !== 'string' || !args.reason) return 'missing reason'
      if (typeof args.summary !== 'string' || !args.summary) return 'missing summary'
      if (!PRIORITIES.has(String(args.priority))) return `bad priority ${args.priority}`
      return null
    }
    case 'notify_team': {
      if (typeof args.subject !== 'string' || !args.subject) return 'missing subject'
      return null
    }
    default:
      return null
  }
}

/** Default side-effect tool: local only (records the ticket in memory; never sends anything). */
export const localTicketTool: ToolFn<string> = async (args) => `ticket:${String(args.priority)}:${String(args.reason).slice(0, 40)}`
