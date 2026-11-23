/**
 * Response cache for stateless answers (retrieval/FAQ turns), keyed by
 * sha256(normalized question) + business + policy version, with TTL.
 *   default: in-memory LRU (CACHE_MAX_ENTRIES, ANSWER_CACHE_TTL_MS)
 *   REDIS_URL=redis://host:6379  -> Redis via a tiny built-in RESP client (GET / SET PX),
 *   falling back to the LRU if Redis is unreachable. No extra npm dependency.
 * Hit/miss counters feed the replay harness ("cache hit rate").
 */
import { createHash } from 'node:crypto'
import net from 'node:net'

export const normalizeQuestion = (text: string): string =>
  text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim()

export function cacheKey(text: string, business: string, policyVersion: string): string {
  const h = createHash('sha256').update(normalizeQuestion(text)).digest('hex').slice(0, 32)
  return `rc:${business}:${policyVersion}:${h}`
}

export interface CacheStats {
  hits: number
  misses: number
  sets: number
  errors: number
  backend: 'memory' | 'redis'
}

export interface ResponseCache {
  key(text: string, business: string, policyVersion: string): string
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  stats(): CacheStats
  resetStats(): void
  close?(): Promise<void>
}

abstract class Counted {
  protected s: CacheStats
  constructor(backend: CacheStats['backend']) {
    this.s = { hits: 0, misses: 0, sets: 0, errors: 0, backend }
  }
  key(text: string, business: string, policyVersion: string): string {
    return cacheKey(text, business, policyVersion)
  }
  stats(): CacheStats {
    return { ...this.s }
  }
  resetStats(): void {
    this.s = { ...this.s, hits: 0, misses: 0, sets: 0, errors: 0 }
  }
}

export class LruCache extends Counted implements ResponseCache {
  private map = new Map<string, { value: string; expires: number }>()
  private readonly ttlMs: number
  private readonly max: number
  private readonly clock: () => number
  constructor(ttlMs: number, max = 500, clock: () => number = Date.now) {
    super('memory')
    this.ttlMs = ttlMs
    this.max = max
    this.clock = clock
  }
  /** Synchronous peek used by tests/back-compat. */
  getSync(key: string): string | null {
    const hit = this.map.get(key)
    if (!hit) return null
    if (hit.expires < this.clock()) {
      this.map.delete(key)
      return null
    }
    this.map.delete(key) // refresh LRU position
    this.map.set(key, hit)
    return hit.value
  }
  async get(key: string): Promise<string | null> {
    const v = this.getSync(key)
    if (v === null) this.s.misses++
    else this.s.hits++
    return v
  }
  /** Sync so callers that do not await still populate the cache. */
  set(key: string, value: string): Promise<void> {
    this.map.delete(key)
    this.map.set(key, { value, expires: this.clock() + this.ttlMs })
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string)
    this.s.sets++
    return Promise.resolve()
  }
  get size(): number {
    return this.map.size
  }
}

/** Minimal RESP2 encoder/decoder - enough for GET/SET/PING. */
export function encodeCommand(args: string[]): string {
  return `*${args.length}\r\n` + args.map((a) => `$${Buffer.byteLength(a)}\r\n${a}\r\n`).join('')
}
type Resp = string | number | null | Error
export function parseReply(buf: string): { value: Resp; rest: string } | null {
  const nl = buf.indexOf('\r\n')
  if (nl < 0) return null
  const t = buf[0]
  const line = buf.slice(1, nl)
  const rest = buf.slice(nl + 2)
  if (t === '+') return { value: line, rest }
  if (t === '-') return { value: new Error(line), rest }
  if (t === ':') return { value: Number(line), rest }
  if (t === '$') {
    const n = Number(line)
    if (n < 0) return { value: null, rest }
    if (Buffer.byteLength(rest) < n + 2) return null
    const b = Buffer.from(rest)
    return { value: b.subarray(0, n).toString(), rest: b.subarray(n + 2).toString() }
  }
  return { value: new Error(`unsupported RESP type ${t}`), rest: '' }
}

export class RedisCache extends Counted implements ResponseCache {
  private sock: net.Socket | null = null
  private buf = ''
  private queue: Array<{ resolve: (v: Resp) => void; reject: (e: Error) => void }> = []
  private readonly url: URL
  private readonly ttlMs: number
  private readonly timeoutMs: number
  private readonly fallback: LruCache
  constructor(redisUrl: string, ttlMs: number, opts: { timeoutMs?: number; fallback?: LruCache } = {}) {
    super('redis')
    this.url = new URL(redisUrl)
    this.ttlMs = ttlMs
    this.timeoutMs = opts.timeoutMs ?? 150
    this.fallback = opts.fallback ?? new LruCache(ttlMs)
  }
  private connect(): Promise<net.Socket> {
    if (this.sock && !this.sock.destroyed) return Promise.resolve(this.sock)
    return new Promise((resolve, reject) => {
      const s = net.createConnection({ host: this.url.hostname || '127.0.0.1', port: Number(this.url.port || 6379) })
      s.setEncoding('utf8')
      const fail = (e: Error) => {
        this.sock = null
        for (const q of this.queue.splice(0)) q.reject(e)
        reject(e)
      }
      s.once('error', fail)
      s.on('close', () => fail(new Error('redis closed')))
      s.on('data', (d: string) => {
        this.buf += d
        for (;;) {
          const r = parseReply(this.buf)
          if (!r) break
          this.buf = r.rest
          this.queue.shift()?.resolve(r.value)
        }
      })
      s.once('connect', async () => {
        this.sock = s
        try {
          if (this.url.password) await this.send(['AUTH', ...(this.url.username ? [decodeURIComponent(this.url.username)] : []), decodeURIComponent(this.url.password)])
          resolve(s)
        } catch (e) {
          reject(e as Error)
        }
      })
    })
  }
  private send(args: string[]): Promise<Resp> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('redis timeout')), this.timeoutMs)
      this.queue.push({
        resolve: (v) => (clearTimeout(timer), v instanceof Error ? reject(v) : resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      })
      this.sock!.write(encodeCommand(args))
    })
  }
  private async cmd(args: string[]): Promise<Resp> {
    await this.connect()
    return this.send(args)
  }
  async get(key: string): Promise<string | null> {
    try {
      const v = await this.cmd(['GET', key])
      if (typeof v === 'string') {
        this.s.hits++
        return v
      }
      this.s.misses++
      return null
    } catch {
      this.s.errors++
      const v = await this.fallback.get(key)
      if (v === null) this.s.misses++
      else this.s.hits++
      return v
    }
  }
  async set(key: string, value: string): Promise<void> {
    this.s.sets++
    try {
      await this.cmd(['SET', key, value, 'PX', String(this.ttlMs)])
    } catch {
      this.s.errors++
      await this.fallback.set(key, value)
    }
  }
  async close(): Promise<void> {
    this.sock?.destroy()
    this.sock = null
  }
}

export function createResponseCache(env: Record<string, string | undefined> = process.env, ttlMs = 600_000): ResponseCache {
  const max = Number(env.CACHE_MAX_ENTRIES || 500) || 500
  if (env.REDIS_URL) return new RedisCache(env.REDIS_URL, ttlMs, { fallback: new LruCache(ttlMs, max) })
  return new LruCache(ttlMs, max)
}
