/**
 * Express routes for the traced agent pipeline + browser trace ingest.
 * Mounted from server/index.ts. Local only - nothing here sends WhatsApp/SMS/calls.
 */
import type { Express } from 'express'
import { AgentRuntime } from './agentTurn.ts'
import { appendJsonl, DEFAULT_TRACE_FILE, logRouterDecision, sanitizeBrowserTurn } from './tracing.ts'

export function mountAgentRoutes(app: Express, env: NodeJS.ProcessEnv = process.env): AgentRuntime {
  const agent = new AgentRuntime({ enforceRouter: env.ROUTER_ENFORCE === '1', storeText: env.TRACE_STORE_TEXT === '1' })
  const traceFile = env.TRACE_FILE || DEFAULT_TRACE_FILE

  app.post('/api/agent/start', (req, res) => {
    const { business, afterHours, callId, channel } = req.body ?? {}
    const out = agent.start({
      business: business ? String(business) : 'mm-dental',
      afterHours: Boolean(afterHours),
      callId: callId ? String(callId).slice(0, 80) : undefined,
      channel: channel ? String(channel).slice(0, 20) : 'voice',
    })
    res.json({ ok: true, ...out })
  })

  app.post('/api/agent/turn', async (req, res) => {
    const callId = String(req.body?.callId || '')
    if (!callId || !agent.has(callId)) {
      res.status(404).json({ ok: false, error: 'unknown callId - POST /api/agent/start first' })
      return
    }
    try {
      const r = await agent.turn(callId, String(req.body?.text || '').slice(0, 1000))
      const { text, firstAudioText, route, outcome, step, handoff } = r
      res.json({ ok: true, callId, text, firstAudioText, route, outcome, step, handoff, traceId: r.trace.trace_id, turnId: r.trace.turn_id })
    } catch (e) {
      console.error('[agent/turn]', e)
      res.status(500).json({ ok: false, error: e instanceof Error ? e.message : 'turn failed' })
    }
  })

  app.post('/api/agent/end', (req, res) => {
    agent.end(String(req.body?.callId || ''))
    res.json({ ok: true })
  })

  /** Browser demo posts one record per turn (VITE_TRACE=1). */
  app.post('/api/trace', (req, res) => {
    if (env.TRACE_INGEST === '0') {
      res.status(403).json({ ok: false, error: 'trace ingest disabled' })
      return
    }
    const parsed = sanitizeBrowserTurn(req.body)
    if (!parsed) {
      res.status(400).json({ ok: false, error: 'invalid trace' })
      return
    }
    appendJsonl(traceFile, parsed.turn)
    if (parsed.decision) logRouterDecision(parsed.decision)
    res.json({ ok: true })
  })

  return agent
}
