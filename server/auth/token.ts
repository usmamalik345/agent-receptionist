/**
 * Session tokens: compact JWT (HS256) signed with AUTH_SECRET, carried in an httpOnly cookie
 * (browser console) or an `Authorization: Bearer` header (API clients). Short-lived; the
 * signature and expiry are checked on every request. No external dependency.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

export type Role = 'admin' | 'staff'
export interface SessionClaims {
  sub: string
  email: string
  role: Role
  /** staff only */
  tenant: string | null
  iat: number
  exp: number
}

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url')
const HEADER = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))

export const MIN_SECRET_LENGTH = 32

export function signSession(c: Omit<SessionClaims, 'iat' | 'exp'>, secret: string, ttlSec: number, nowSec = Math.floor(Date.now() / 1000)): string {
  if (secret.length < MIN_SECRET_LENGTH) throw new Error('AUTH_SECRET too short')
  const body = b64u(JSON.stringify({ ...c, iat: nowSec, exp: nowSec + ttlSec }))
  const sig = createHmac('sha256', secret).update(`${HEADER}.${body}`).digest('base64url')
  return `${HEADER}.${body}.${sig}`
}

export function verifySession(token: string, secret: string, nowSec = Math.floor(Date.now() / 1000)): SessionClaims | null {
  if (typeof token !== 'string' || token.length > 4096) return null
  const [h, body, sig] = token.split('.')
  if (!h || !body || !sig || h !== HEADER) return null
  const want = createHmac('sha256', secret).update(`${h}.${body}`).digest()
  const got = Buffer.from(sig, 'base64url')
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null
  try {
    const c = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionClaims
    if (typeof c.exp !== 'number' || c.exp <= nowSec) return null
    if (c.role !== 'admin' && c.role !== 'staff') return null
    if (c.role === 'staff' && !c.tenant) return null
    return c
  } catch {
    return null
  }
}
