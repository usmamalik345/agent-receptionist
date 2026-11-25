/** Auth: password hashing, session tokens, login ok/bad/rate limit, protected routes, role + tenant isolation, revocation, config. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import express from 'express'
import { LruCache } from '../server/cache.ts'
import { createAuth, LoginLimiter, SESSION_COOKIE } from '../server/auth/http.ts'
import { hashPassword, verifyPassword } from '../server/auth/password.ts'
import { signSession, verifySession } from '../server/auth/token.ts'
import { MemoryUserRepo } from '../server/auth/users.ts'
import { seedUsersFromEnv } from '../server/platform/bootstrap.ts'
import { loadPlatformEnv } from '../server/platform/config.ts'
import { mountPlatformRoutes } from '../server/platform/http.ts'
import { silentLogger } from '../server/platform/logger.ts'
import { Platform } from '../server/platform/orchestrator.ts'
import { loadTenants } from '../server/platform/registry.ts'

const SECRET = 'test-secret-'.padEnd(48, 'x')
const FAST = { N: 1 << 10 } // cheap scrypt cost for tests only
const { tenants } = loadTenants()
const PW = 'correct horse battery'

async function server(o: { limiter?: LoginLimiter; auth?: boolean } = {}) {
  const users = new MemoryUserRepo()
  const hash = await hashPassword(PW, FAST)
  const admin = await users.upsert({ email: 'Admin@Example.com', passwordHash: hash, role: 'admin', tenantId: null })
  const erth = await users.upsert({ email: 'front@erth.example', passwordHash: hash, role: 'staff', tenantId: 'erth-abu-dhabi' })
  await users.upsert({ email: 'desk@mm.example', passwordHash: hash, role: 'staff', tenantId: 'mm-dental-care' })
  const app = express()
  app.use(express.json())
  const platform = new Platform({ tenants, traceSink: () => {}, cache: new LruCache(60_000), now: () => new Date('2026-11-25T09:00:00Z') })
  const auth = o.auth === false ? undefined : createAuth({ users, secret: SECRET, logger: silentLogger, limiter: o.limiter })
  mountPlatformRoutes(app, platform, { logger: silentLogger, tenantErrors: [], auth })
  const srv = app.listen(0)
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`
  const call = (path: string, init: RequestInit & { cookie?: string } = {}) =>
    fetch(`${base}${path}`, { ...init, headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.cookie ? { cookie: init.cookie } : {}), ...(init.headers as Record<string, string> | undefined) } })
  const login = async (email: string, password = PW) => {
    const r = await call('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) })
    const set = r.headers.get('set-cookie') ?? ''
    return { r, body: await r.json(), set, cookie: set.split(';')[0] }
  }
  return { base, call, login, users, ids: { admin: admin.id, erth: erth.id }, close: () => srv.close() }
}

test('password: scrypt hash verifies, wrong password fails, hashes are salted, short passwords refused', async () => {
  const h = await hashPassword(PW, FAST)
  assert.match(h, /^scrypt\$1024\$8\$1\$/)
  assert.ok(await verifyPassword(PW, h))
  assert.equal(await verifyPassword('correct horse battery!', h), false)
  assert.notEqual(h, await hashPassword(PW, FAST))
  assert.equal(await verifyPassword(PW, 'not-a-hash'), false)
  await assert.rejects(hashPassword('short'), /at least 10/)
})

test('session token: signed + expiring; tampered, wrong-key, expired and malformed tokens are rejected', () => {
  const t = signSession({ sub: 'u1', email: 'a@b.co', role: 'staff', tenant: 'erth-abu-dhabi' }, SECRET, 60, 1000)
  assert.equal(verifySession(t, SECRET, 1001)?.tenant, 'erth-abu-dhabi')
  assert.equal(verifySession(t, SECRET, 1061), null, 'expired')
  assert.equal(verifySession(t, 'another-secret'.padEnd(40, 'y'), 1001), null)
  const [h, body, sig] = t.split('.')
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), role: 'admin', tenant: null })).toString('base64url')
  assert.equal(verifySession(`${h}.${forged}.${sig}`, SECRET, 1001), null, 'privilege escalation by editing the payload')
  assert.equal(verifySession('a.b', SECRET), null)
  assert.throws(() => signSession({ sub: 'u', email: 'e', role: 'admin', tenant: null }, 'short', 60))
})

test('login: ok sets an httpOnly SameSite cookie; wrong password / unknown email get the same 401; me + logout', async () => {
  const s = await server()
  try {
    const ok = await s.login('ADMIN@example.com ')
    assert.equal(ok.r.status, 200)
    assert.deepEqual(ok.body.user, { email: 'admin@example.com', role: 'admin', tenantId: null })
    assert.equal(ok.body.token, undefined, 'token is not exposed to page JS')
    assert.match(ok.set, new RegExp(`^${SESSION_COOKIE}=`))
    assert.match(ok.set, /HttpOnly/)
    assert.match(ok.set, /SameSite=Lax/)
    const me = await s.call('/api/v1/auth/me', { cookie: ok.cookie })
    assert.equal(me.status, 200)
    assert.deepEqual((await me.json()).user.role, 'admin')
    const bad = await s.login('admin@example.com', 'wrong password!')
    const unknown = await s.login('nobody@example.com')
    assert.equal(bad.r.status, 401)
    assert.equal(unknown.r.status, 401)
    assert.equal(bad.body.error, unknown.body.error, 'no user enumeration')
    assert.equal((await s.call('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ email: 'a@b.co' }) })).status, 400)
    const out = await s.call('/api/v1/auth/logout', { method: 'POST', cookie: ok.cookie })
    assert.match(out.headers.get('set-cookie') ?? '', /Max-Age=0/)
    assert.equal((await s.call('/api/v1/auth/me')).status, 401)
  } finally {
    s.close()
  }
})

test('login rate limit: 5 failures per email/IP in the window -> 429 with Retry-After, even for the right password', async () => {
  let now = 0
  const s = await server({ limiter: new LoginLimiter({ maxFailures: 5, windowMs: 60_000, clock: () => now }) })
  try {
    for (let i = 0; i < 5; i++) assert.equal((await s.login('front@erth.example', `wrong password ${i}`)).r.status, 401)
    const blocked = await s.login('front@erth.example')
    assert.equal(blocked.r.status, 429)
    assert.ok(Number(blocked.r.headers.get('retry-after')) > 0)
    now = 61_000
    assert.equal((await s.login('front@erth.example')).r.status, 200, 'window slid: allowed again')
  } finally {
    s.close()
  }
})

test('protected routes: no session -> 401 on every tenant route; health stays public', async () => {
  const s = await server()
  try {
    assert.equal((await s.call('/healthz')).status, 200)
    assert.equal((await s.call('/readyz')).status, 200)
    for (const [m, p] of [['GET', '/api/v1/tenants'], ['GET', '/api/v1/tenants/erth-abu-dhabi'], ['POST', '/api/v1/tenants/erth-abu-dhabi/calls'], ['GET', '/api/v1/tenants/erth-abu-dhabi/bookings'], ['GET', '/api/v1/tenants/erth-abu-dhabi/call-log']] as const) {
      assert.equal((await s.call(p, { method: m })).status, 401, `${m} ${p}`)
    }
    assert.equal((await s.call('/api/v1/tenants', { cookie: `${SESSION_COOKIE}=garbage` })).status, 401)
  } finally {
    s.close()
  }
})

test('roles: staff reach only their own tenant (403 elsewhere, list filtered); admin reaches all', async () => {
  const s = await server()
  try {
    const staff = (await s.login('front@erth.example')).cookie
    const admin = (await s.login('admin@example.com')).cookie
    const list = await (await s.call('/api/v1/tenants', { cookie: staff })).json()
    assert.deepEqual(list.tenants.map((t: { id: string }) => t.id), ['erth-abu-dhabi'])
    assert.equal((await (await s.call('/api/v1/tenants', { cookie: admin })).json()).tenants.length, 22)
    const start = await s.call('/api/v1/tenants/erth-abu-dhabi/calls', { method: 'POST', cookie: staff })
    assert.equal(start.status, 201)
    const { callId } = await start.json()
    assert.equal((await s.call(`/api/v1/tenants/erth-abu-dhabi/calls/${callId}/turns`, { method: 'POST', cookie: staff, body: JSON.stringify({ text: 'What time is check-in?' }) })).status, 200)
    for (const [m, p] of [['GET', '/api/v1/tenants/mm-dental-care'], ['POST', '/api/v1/tenants/mm-dental-care/calls'], ['GET', '/api/v1/tenants/mm-dental-care/bookings'], ['GET', '/api/v1/tenants/mm-dental-care/call-log'], ['DELETE', `/api/v1/tenants/mm-dental-care/calls/${callId}`]] as const) {
      assert.equal((await s.call(p, { method: m, cookie: staff })).status, 403, `${m} ${p}`)
    }
    assert.equal((await s.call('/api/v1/tenants/mm-dental-care/bookings', { cookie: admin })).status, 200)
    const log = await (await s.call('/api/v1/tenants/erth-abu-dhabi/call-log', { cookie: staff })).json()
    assert.equal(log.calls[0].id, callId)
    assert.equal(log.calls[0].turns, 1)
    // CSRF: a cookie-authenticated write with a non-JSON body is refused
    assert.equal((await s.call('/api/v1/tenants/erth-abu-dhabi/calls', { method: 'POST', cookie: staff, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=1' })).status, 415)
  } finally {
    s.close()
  }
})

test('bearer tokens for API clients; disabling a user revokes access on the next request', async () => {
  const s = await server()
  try {
    const r = await s.call('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ email: 'front@erth.example', password: PW, issueToken: true }) })
    const { token } = await r.json()
    const auth = { authorization: `Bearer ${token}` }
    assert.equal((await s.call('/api/v1/tenants/erth-abu-dhabi/bookings', { headers: auth })).status, 200)
    assert.equal((await s.call('/api/v1/tenants/mm-dental-care/bookings', { headers: auth })).status, 403)
    const u = (await s.users.byEmail('front@erth.example'))!
    await s.users.upsert({ ...u, disabled: true })
    assert.equal((await s.call('/api/v1/tenants/erth-abu-dhabi/bookings', { headers: auth })).status, 401)
    assert.equal((await s.login('front@erth.example')).r.status, 401, 'disabled user cannot log in')
  } finally {
    s.close()
  }
})

test('demo mode (no AUTH_SECRET): API stays open and /auth/me says auth is off, so the static console keeps working', async () => {
  const s = await server({ auth: false })
  try {
    assert.deepEqual(await (await s.call('/api/v1/auth/me')).json(), { ok: true, authEnabled: false, user: null })
    assert.equal((await s.call('/api/v1/tenants/erth-abu-dhabi/bookings')).status, 200)
  } finally {
    s.close()
  }
})

test('config: production refuses to boot without AUTH_SECRET / DATABASE_URL; short secrets and bad URLs are flagged', () => {
  const prod = loadPlatformEnv({ NODE_ENV: 'production', CORS_ORIGINS: 'https://x.example' })
  assert.ok(prod.problems.some((p) => p.startsWith('AUTH_SECRET must be set')))
  assert.ok(prod.problems.some((p) => p.startsWith('DATABASE_URL must be set')))
  const ok = loadPlatformEnv({ NODE_ENV: 'production', CORS_ORIGINS: 'https://x.example', AUTH_SECRET: SECRET, DATABASE_URL: 'postgres://app@db/x' })
  assert.deepEqual(ok.problems, [])
  assert.equal(ok.config.cookieSecure, true)
  assert.equal(ok.config.authTtlSec, 8 * 3600)
  assert.ok(loadPlatformEnv({ AUTH_SECRET: 'short' }).problems.some((p) => /at least 32/.test(p)))
  assert.ok(loadPlatformEnv({ DATABASE_URL: 'mysql://x' }).problems.some((p) => /DATABASE_URL/.test(p)))
  assert.deepEqual(loadPlatformEnv({}).problems, [], 'dev/demo defaults need nothing')
})

test('seed users from env: admin + staff per known tenant; unknown tenant is an error', async () => {
  const users = new MemoryUserRepo()
  const seeded = await seedUsersFromEnv(users, tenants, { SEED_ADMIN_EMAIL: 'ops@example.com', SEED_ADMIN_PASSWORD: 'admin-pass-123', SEED_STAFF_USERS: 'front@erth.example=erth-abu-dhabi, desk@mm.example=mm-dental-care', SEED_STAFF_PASSWORD: 'staff-pass-123' })
  assert.equal(seeded.length, 3)
  assert.equal((await users.byEmail('desk@mm.example'))?.tenantId, 'mm-dental-care')
  assert.ok(await verifyPassword('admin-pass-123', (await users.byEmail('ops@example.com'))!.passwordHash))
  await assert.rejects(seedUsersFromEnv(users, tenants, { SEED_STAFF_USERS: 'x@y.co=no-such-tenant', SEED_STAFF_PASSWORD: 'staff-pass-123' }), /known tenant/)
})
