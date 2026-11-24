/**
 * Structured JSON logs (one line per event) to stdout. LOG_LEVEL=debug|info|warn|error.
 * Never logs caller text, names or phone numbers: only ids, lengths and decisions.
 */
type Level = 'debug' | 'info' | 'warn' | 'error'
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export interface Logger {
  log(level: Level, msg: string, fields?: Record<string, unknown>): void
  info(msg: string, fields?: Record<string, unknown>): void
  warn(msg: string, fields?: Record<string, unknown>): void
  error(msg: string, fields?: Record<string, unknown>): void
}

const BANNED = /^(text|name|phone|caller_text|user_text|args)$/i

export function createLogger(opts: { level?: string; write?: (line: string) => void; service?: string } = {}): Logger {
  const min = ORDER[(opts.level ?? process.env.LOG_LEVEL ?? 'info') as Level] ?? ORDER.info
  const write = opts.write ?? ((l: string) => process.stdout.write(l + '\n'))
  const log = (level: Level, msg: string, fields: Record<string, unknown> = {}) => {
    if (ORDER[level] < min) return
    const safe: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(fields)) safe[k] = BANNED.test(k) ? '[redacted]' : v
    write(JSON.stringify({ ts: new Date().toISOString(), level, service: opts.service ?? 'receptionist', msg, ...safe }))
  }
  return { log, info: (m, f) => log('info', m, f), warn: (m, f) => log('warn', m, f), error: (m, f) => log('error', m, f) }
}

export const silentLogger: Logger = { log() {}, info() {}, warn() {}, error() {} }
