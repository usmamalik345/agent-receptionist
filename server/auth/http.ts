/**
 * Auth for the platform API and the console.
 *   POST /api/v1/auth/login   { email, password }   -> sets httpOnly session cookie
 *   POST /api/v1/auth/logout                       -> clears it
 *   GET  /api/v1/auth/me                           -> { authEnabled, user } or 401
 * Roles: admin = every tenant; staff = only their own tenant. `requireUser` + `canAccess`
 * protect every tenant route (see server/platform/http.ts). Login is rate-limited per IP and
 * per email; failures return one generic message (no user enumeration).
 */
import type { Express, NextFunction, Request, Response } from 'express'
import type { Logger } from '../platform/logger.ts'
import { dummyHash, verifyPassword } from './password.ts'
import { signSession, verifySession, type SessionClaims } from './token.ts'
import { normEmail, type UserRepo } from './users.ts'

export const SESSION_COOKIE = 'fdo_session'

export interface AuthOptions {
  users: UserRepo
  secret: string
  /** session lifetime, seconds (default 8h) */
  ttlSec?: number
  /** Secure cookie flag (true in production / behind HTTPS) */
  secureCookie?: boolean
  logger: Logger
  limiter?: LoginLimiter
}

export type AuthedUser = Pick<SessionClaims, 'sub' | 'email' | 'role' | 'tenant'>

/** Sliding-window login limiter: N failures per key (ip:…, email:…) within the window -> blocked until it slides. */
export class LoginLimiter {
  private readonly fails = new Map<string, number[]>()
  private readonly max: number
  private readonly windowMs: number
  private readonly clock: () => number
  constructor(o: { maxFailures?: number; windowMs?: number; clock?: () => number } = {}) {
    this.max = o.maxFailures ?? 5
    this.windowMs = o.windowMs ?? 15 * 60_000
    this.clock = o.clock ?? Date.now
  }
  private recent(key: string): number[] {
    const now = this.clock()
    const r = (this.fails.get(key) ?? []).filter((t) => now - t < this.windowMs)
    if (r.length) this.fails.set(key, r)
    else this.fails.delete(key)
    return r
  }
  /** 0 when allowed, else ms until the oldest failure leaves the window */
  retryAfterMs(keys: string[]): number {
    let wait = 0
    for (const k of keys) {
      const r = this.recent(k)
      if (r.length >= this.max) wait = Math.max(wait, r[0] + this.windowMs - this.clock())
    }
    return wait
  }
  fail(keys: string[]): void {
    for (const k of keys) this.fails.set(k, [...this.recent(k), this.clock()])
    if (this.fails.size > 50_000) this.fails.clear() // memory guard under a spray attack
  }
  clear(key: string): void {
    this.fails.delete(key)
  }
}

export function canAccess(u: AuthedUser, tenantId: string): boolean {
  return u.role === 'admin' || (u.role === 'staff' && u.tenant === tenantId)
}

function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.cookie
  if (!raw) return null
  for (const part of raw.split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim())
  }
  return null
}

export interface Auth {
  /** sets res.locals.user or answers 401 */
  requireUser: (req: Request, res: Response, next: NextFunction) => void
  /** after requireUser on routes with :tenantId; answers 403 for another tenant's staff */
  requireTenant: (req: Request, res: Response, next: NextFunction) => void
  mount(app: Express): void
}

export function createAuth(o: AuthOptions): Auth {
  const ttl = o.ttlSec ?? 8 * 3600
  const limiter = o.limiter ?? new LoginLimiter()
  const cookie = (value: string, maxAge: number) =>
    `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${o.secureCookie ? '; Secure' : ''}`

  const fromRequest = (req: Request): { claims: SessionClaims; via: 'cookie' | 'bearer' } | null => {
    const h = req.headers.authorization
    if (h?.startsWith('Bearer ')) {
      const c = verifySession(h.slice(7).trim(), o.secret)
      return c ? { claims: c, via: 'bearer' } : null
    }
    const tok = readCookie(req, SESSION_COOKIE)
    const c = tok ? verifySession(tok, o.secret) : null
    return c ? { claims: c, via: 'cookie' } : null
  }

  const requireUser = async (req: Request, res: Response, next: NextFunction) => {
    const s = fromRequest(req)
    if (!s) return void res.status(401).json({ ok: false, error: 'unauthenticated' })
    // CSRF: cookie sessions are SameSite=Lax (not sent on cross-site POSTs); a write with a body must also be
    // JSON, which a cross-site HTML form cannot send
    if (s.via === 'cookie' && req.method === 'POST' && req.headers['content-type'] && !req.is('application/json')) return void res.status(415).json({ ok: false, error: 'json required' })
    // Revocation: a disabled or deleted user loses access on the next request, not at token expiry
    try {
      const u = await o.users.byId(s.claims.sub)
      if (!u || u.disabled || u.role !== s.claims.role || (u.tenantId ?? null) !== (s.claims.tenant ?? null)) return void res.status(401).json({ ok: false, error: 'unauthenticated' })
    } catch (e) {
      o.logger.error('auth_user_lookup_failed', { error: e instanceof Error ? e.message : String(e) })
      return void res.status(503).json({ ok: false, error: 'auth unavailable' })
    }
    res.locals.user = { sub: s.claims.sub, email: s.claims.email, role: s.claims.role, tenant: s.claims.tenant } satisfies AuthedUser
    next()
  }

  const requireTenant = (req: Request, res: Response, next: NextFunction) => {
    const u = res.locals.user as AuthedUser | undefined
    const tenantId = (req.params as Record<string, string | undefined>).tenantId
    if (!u) return void res.status(401).json({ ok: false, error: 'unauthenticated' })
    if (tenantId && !canAccess(u, tenantId)) {
      o.logger.warn('tenant_access_denied', { user: u.sub, role: u.role, tenant: tenantId })
      return void res.status(403).json({ ok: false, error: 'forbidden' })
    }
    next()
  }

  const guard = (req: Request, res: Response, next: NextFunction) => void requireUser(req, res, next)
  return {
    requireUser: guard,
    requireTenant,
    mount(app) {
      app.post('/api/v1/auth/login', async (req, res) => {
        const email = normEmail(req.body?.email)
        const password = req.body?.password
        if (!email || typeof password !== 'string' || !password || password.length > 256 || email.length > 254) {
          return void res.status(400).json({ ok: false, error: 'email and password required' })
        }
        const keys = [`ip:${req.ip ?? 'unknown'}`, `email:${email}`]
        const wait = limiter.retryAfterMs(keys)
        if (wait > 0) {
          res.setHeader('Retry-After', String(Math.ceil(wait / 1000)))
          return void res.status(429).json({ ok: false, error: 'too many attempts, try again later' })
        }
        try {
          const u = await o.users.byEmail(email)
          const ok = await verifyPassword(password, u?.passwordHash ?? (await dummyHash()))
          if (!u || !ok || u.disabled) {
            limiter.fail(keys)
            o.logger.warn('login_failed', { reason: !u ? 'unknown_email' : u.disabled ? 'disabled' : 'bad_password' })
            return void res.status(401).json({ ok: false, error: 'invalid email or password' })
          }
          limiter.clear(`email:${email}`)
          const token = signSession({ sub: u.id, email: u.email, role: u.role, tenant: u.tenantId }, o.secret, ttl)
          await o.users.touchLogin(u.id, new Date().toISOString()).catch(() => {})
          o.logger.info('login', { user: u.id, role: u.role, tenant: u.tenantId })
          res.setHeader('Set-Cookie', cookie(token, ttl))
          res.setHeader('Cache-Control', 'no-store')
          res.json({ ok: true, user: { email: u.email, role: u.role, tenantId: u.tenantId }, expiresIn: ttl, ...(req.body?.issueToken === true ? { token } : {}) })
        } catch (e) {
          o.logger.error('login_error', { error: e instanceof Error ? e.message : String(e) })
          res.status(500).json({ ok: false, error: 'internal error' })
        }
      })
      app.post('/api/v1/auth/logout', (_req, res) => {
        res.setHeader('Set-Cookie', cookie('', 0))
        res.json({ ok: true })
      })
      app.get('/api/v1/auth/me', guard, (_req, res) => {
        const u = res.locals.user as AuthedUser
        res.setHeader('Cache-Control', 'no-store')
        res.json({ ok: true, authEnabled: true, user: { email: u.email, role: u.role, tenantId: u.tenant } })
      })
    },
  }
}
