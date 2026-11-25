/**
 * HTTP API for the platform (Express). Mounted by server/index.ts and by the
 * production entry server/platform/main.ts.
 *   GET  /healthz                                  liveness
 *   GET  /readyz                                   readiness (tenants loaded, config ok)
 *   GET  /api/v1/tenants                           public tenant list
 *   GET  /api/v1/tenants/:tenantId                 public tenant info + voice persona
 *   POST /api/v1/tenants/:tenantId/calls           start a call
 *   POST /api/v1/tenants/:tenantId/calls/:callId/turns     { text }
 *   POST /api/v1/tenants/:tenantId/calls/:callId/silence   { ms }
 *   DELETE /api/v1/tenants/:tenantId/calls/:callId
 *   GET  /api/v1/tenants/:tenantId/bookings                confirmed bookings (from the store / database)
 *   GET  /api/v1/tenants/:tenantId/call-log                recent calls; /call-log/:callId = its turns
 *   /api/v1/auth/*                                         login / logout / me (server/auth/http.ts)
 * With `auth` set (production), everything under /api/v1/tenants needs a session and staff only
 * reach their own tenant. Without it (local dev, tests, static demo) the API is open and
 * /api/v1/auth/me answers { authEnabled: false }.
 */
import type { Express, NextFunction, Request, Response } from 'express'
import type { Auth, AuthedUser } from '../auth/http.ts'
import type { Logger } from './logger.ts'
import { Platform, PlatformError } from './orchestrator.ts'

export interface MountOptions {
  logger: Logger
  tenantErrors: Array<{ file: string; problems: string[] }>
  configProblems?: string[]
  startedAt?: number
  /** session auth + tenant access control; omit for an open local/demo API */
  auth?: Auth
  /** readiness probe for the database (omit when there is none) */
  dbReady?: () => Promise<boolean>
  storage?: 'memory' | 'postgres' | 'sqlite'
}

const ID = /^[a-z0-9][a-z0-9-]{1,48}$/
const CALL = /^[A-Za-z0-9-]{8,80}$/

export function mountPlatformRoutes(app: Express, platform: Platform, o: MountOptions): void {
  const startedAt = o.startedAt ?? Date.now()
  const send = (res: Response, e: unknown) => {
    if (e instanceof PlatformError) {
      if (e.retryAfterMs) res.setHeader('Retry-After', String(Math.ceil(e.retryAfterMs / 1000)))
      res.status(e.status).json({ ok: false, error: e.message })
      return
    }
    o.logger.error('unhandled', { error: e instanceof Error ? e.message : String(e) })
    res.status(500).json({ ok: false, error: 'internal error' })
  }
  const ids = (req: Request, res: Response, next: NextFunction) => {
    const { tenantId, callId } = req.params as Record<string, string | undefined>
    if (tenantId !== undefined && !ID.test(tenantId)) return void res.status(400).json({ ok: false, error: 'bad tenant id' })
    if (callId !== undefined && !CALL.test(callId)) return void res.status(400).json({ ok: false, error: 'bad call id' })
    next()
  }

  const open = (_req: Request, _res: Response, next: NextFunction) => next()
  const user = o.auth?.requireUser ?? open
  const tenantAccess = o.auth?.requireTenant ?? open
  const guarded = [ids, user, tenantAccess]
  if (o.auth) o.auth.mount(app)
  else app.get('/api/v1/auth/me', (_req, res) => void res.json({ ok: true, authEnabled: false, user: null }))

  app.get('/healthz', (_req, res) => void res.json({ ok: true, uptime_s: Math.round((Date.now() - startedAt) / 1000) }))
  app.get('/readyz', async (_req, res) => {
    const db = o.dbReady ? await o.dbReady().catch(() => false) : null
    const ready = platform.tenants.size > 0 && !(o.configProblems?.length) && db !== false
    res.status(ready ? 200 : 503).json({
      ok: ready,
      tenants: platform.tenants.size,
      by_vertical: { hotel: [...platform.tenants.values()].filter((t) => t.vertical === 'hotel').length, dental: [...platform.tenants.values()].filter((t) => t.vertical === 'dental').length },
      tenant_file_errors: o.tenantErrors.map((e) => ({ file: e.file, problems: e.problems.length })),
      config_problems: o.configProblems ?? [],
      llm: { provider: platform.llm.provider, primary: platform.llm.primaryModel, small: platform.llm.smallModel },
      cache: platform.cache.stats().backend,
      storage: o.storage ?? 'memory',
      db,
      auth: Boolean(o.auth),
    })
  })
  app.get('/api/v1/tenants', user, (_req, res) => {
    const u = res.locals.user as AuthedUser | undefined
    res.json({ ok: true, tenants: [...platform.tenants.values()].filter((t) => !u || u.role === 'admin' || u.tenant === t.id).map((t) => ({ id: t.id, name: t.name, vertical: t.vertical, sample: t.sample })) })
  })
  app.get('/api/v1/tenants/:tenantId', ...guarded, (req, res) => {
    const t = platform.tenants.get(req.params.tenantId)
    if (!t) return void res.status(404).json({ ok: false, error: 'unknown tenant' })
    res.json({ ok: true, tenant: { id: t.id, name: t.name, vertical: t.vertical, sample: t.sample, voice: t.voice, locations: t.locations.map((l) => ({ name: l.name, phone: l.phone })) } })
  })
  app.post('/api/v1/tenants/:tenantId/calls', ...guarded, (req, res) => {
    try {
      res.status(201).json({ ok: true, ...platform.start(req.params.tenantId) })
    } catch (e) {
      send(res, e)
    }
  })
  app.post('/api/v1/tenants/:tenantId/calls/:callId/turns', ...guarded, async (req, res) => {
    const text = req.body?.text
    if (typeof text !== 'string' || !text.trim() || text.length > 500) return void res.status(400).json({ ok: false, error: 'text: 1-500 chars' })
    try {
      const r = await platform.turn(req.params.tenantId, req.params.callId, text)
      res.json({
        ok: true, text: r.text, chunks: r.chunks, agent: r.agent, intent: r.intent, escalated: r.escalated,
        pending_confirmation: r.pendingConfirmation, booking: r.booking, tools: r.tools.map((t) => ({ agent: t.agent, tool: t.tool, ok: t.ok })),
        trace_id: r.trace.trace_id, turn_id: r.trace.turn_id,
      })
    } catch (e) {
      send(res, e)
    }
  })
  app.post('/api/v1/tenants/:tenantId/calls/:callId/silence', ...guarded, (req, res) => {
    const ms = Number(req.body?.ms)
    if (!Number.isFinite(ms) || ms < 0 || ms > 600_000) return void res.status(400).json({ ok: false, error: 'ms: 0-600000' })
    try {
      res.json({ ok: true, ...platform.silence(req.params.tenantId, req.params.callId, ms) })
    } catch (e) {
      send(res, e)
    }
  })
  app.delete('/api/v1/tenants/:tenantId/calls/:callId', ...guarded, (req, res) => {
    try {
      platform.end(req.params.tenantId, req.params.callId)
      res.json({ ok: true })
    } catch (e) {
      send(res, e)
    }
  })
  app.get('/api/v1/tenants/:tenantId/bookings', ...guarded, async (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store')
      res.json({ ok: true, bookings: (await platform.bookings(req.params.tenantId)).map(({ callId: _c, ...b }) => b) })
    } catch (e) {
      send(res, e)
    }
  })
  app.get('/api/v1/tenants/:tenantId/call-log', ...guarded, async (req, res) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100))
    try {
      res.setHeader('Cache-Control', 'no-store')
      res.json({ ok: true, calls: await platform.calls(req.params.tenantId, limit) })
    } catch (e) {
      send(res, e)
    }
  })
  app.get('/api/v1/tenants/:tenantId/call-log/:callId', ...guarded, async (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store')
      res.json({ ok: true, turns: await platform.callTurns(req.params.tenantId, req.params.callId) })
    } catch (e) {
      send(res, e)
    }
  })
}
