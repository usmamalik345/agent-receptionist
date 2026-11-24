/** Per-tenant token bucket (requests per minute). One noisy tenant can't starve the others. */
export class TenantRateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>()
  private readonly clock: () => number
  constructor(clock: () => number = Date.now) {
    this.clock = clock
  }
  /** Returns 0 when allowed, else ms until the next token. */
  take(tenantId: string, perMinute: number): number {
    const now = this.clock()
    const b = this.buckets.get(tenantId) ?? { tokens: perMinute, at: now }
    b.tokens = Math.min(perMinute, b.tokens + ((now - b.at) / 60_000) * perMinute)
    b.at = now
    this.buckets.set(tenantId, b)
    if (b.tokens >= 1) {
      b.tokens -= 1
      return 0
    }
    return Math.ceil(((1 - b.tokens) / perMinute) * 60_000)
  }
}
