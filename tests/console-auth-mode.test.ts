/** Console mode from /api/v1/auth/me: the static Vercel site must fall back to demo mode, a real API to sign-in. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { modeFrom } from '../src/console/authMode.ts'

const JSON_CT = 'application/json; charset=utf-8'

test('console mode: 401 -> sign-in; signed-in user -> authed; static host / auth off / garbage -> demo', () => {
  assert.deepEqual(modeFrom(401, JSON_CT, { ok: false }), { status: 'anon' })
  const user = { email: 'front@erth.example', role: 'staff', tenantId: 'erth-abu-dhabi' }
  assert.deepEqual(modeFrom(200, JSON_CT, { ok: true, authEnabled: true, user }), { status: 'authed', user })
  assert.equal(modeFrom(404, 'text/plain', null).status, 'demo', 'Vercel static: /api is not rewritten -> 404')
  assert.equal(modeFrom(200, 'text/html', null).status, 'demo', 'SPA fallback served index.html')
  assert.equal(modeFrom(200, JSON_CT, { ok: true, authEnabled: false, user: null }).status, 'demo', 'API with auth off')
  assert.equal(modeFrom(500, JSON_CT, {}).status, 'demo')
  assert.equal(modeFrom(200, JSON_CT, { authEnabled: true, user: { email: 'x', role: 'root', tenantId: null } }).status, 'demo', 'unknown role is not trusted')
})
