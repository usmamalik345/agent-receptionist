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
 */
import type { Express, NextFunction, Request, Response } from 'express'
import type { Logger } from './logger.ts'
import { Platform, PlatformError } from './orchestrator.ts'

export interface MountOptions {
  logger: Logger
  tenantErrors: Array<{ file: string; problems: string[] }>
  configProblems?: string[]
  startedAt?: number
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

  app.get('/healthz', (_req, res) => void res.json({ ok: true, uptime_s: Math.round((Date.now() - startedAt) / 1000) }))
  app.get('/readyz', (_req, res) => {
    const ready = platform.tenants.size > 0 && !(o.configProblems?.length)
    res.status(ready ? 200 : 503).json({
      ok: ready,
      tenants: platform.tenants.size,
      by_vertical: { hotel: [...platform.tenants.values()].filter((t) => t.vertical === 'hotel').length, dental: [...platform.tenants.values()].filter((t) => t.vertical === 'dental').length },
      tenant_file_errors: o.tenantErrors.map((e) => ({ file: e.file, problems: e.problems.length })),
      config_problems: o.configProblems ?? [],
      llm: { provider: platform.llm.provider, primary: platform.llm.primaryModel, small: platform.llm.smallModel },
      cache: platform.cache.stats().backend,
    })
  })
  app.get('/api/v1/tenants', (_req, res) => {
    res.json({ ok: true, tenants: [...platform.tenants.values()].map((t) => ({ id: t.id, name: t.name, vertical: t.vertical, sample: t.sample })) })
  })
  app.get('/api/v1/tenants/:tenantId', ids, (req, res) => {
    const t = platform.tenants.get(req.params.tenantId)
    if (!t) return void res.status(404).json({ ok: false, error: 'unknown tenant' })
    res.json({ ok: true, tenant: { id: t.id, name: t.name, vertical: t.vertical, sample: t.sample, voice: t.voice, locations: t.locations.map((l) => ({ name: l.name, phone: l.phone })) } })
  })
  app.post('/api/v1/tenants/:tenantId/calls', ids, (req, res) => {
    try {
      res.status(201).json({ ok: true, ...platform.start(req.params.tenantId) })
    } catch (e) {
      send(res, e)
    }
  })
  app.post('/api/v1/tenants/:tenantId/calls/:callId/turns', ids, async (req, res) => {
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
  app.post('/api/v1/tenants/:tenantId/calls/:callId/silence', ids, (req, res) => {
    const ms = Number(req.body?.ms)
    if (!Number.isFinite(ms) || ms < 0 || ms > 600_000) return void res.status(400).json({ ok: false, error: 'ms: 0-600000' })
    try {
      res.json({ ok: true, ...platform.silence(req.params.tenantId, req.params.callId, ms) })
    } catch (e) {
      send(res, e)
    }
  })
  app.delete('/api/v1/tenants/:tenantId/calls/:callId', ids, (req, res) => {
    try {
      platform.end(req.params.tenantId, req.params.callId)
      res.json({ ok: true })
    } catch (e) {
      send(res, e)
    }
  })
}
