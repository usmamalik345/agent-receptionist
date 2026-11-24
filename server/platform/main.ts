/**
 * Production entry for the multi-tenant receptionist API (used by the Dockerfile).
 * Only the platform API: no WhatsApp bridge, no demo routes.
 *   PORT, TENANTS_DIR, LOG_LEVEL, RATE_LIMIT_PER_MINUTE, CORS_ORIGINS, LLM_*, REDIS_URL, TRACE_FILE
 */
import 'dotenv/config'
import cors from 'cors'
import express from 'express'
import { loadPlatformEnv } from './config.ts'
import { mountPlatformRoutes } from './http.ts'
import { createLogger } from './logger.ts'
import { Platform } from './orchestrator.ts'
import { loadTenants } from './registry.ts'
import { defaultTraceSink } from '../tracing.ts'

const { config, problems } = loadPlatformEnv()
const logger = createLogger({ level: config.logLevel })
if (problems.length) {
  for (const p of problems) logger.error('config_problem', { problem: p })
  if (config.nodeEnv === 'production') process.exit(1)
}
const { tenants, errors } = loadTenants(config.tenantsDir)
for (const e of errors) logger.error('tenant_file_rejected', { file: e.file, problems: e.problems })
const sink = defaultTraceSink()
// A full disk or read-only volume must not fail a caller's turn: log and carry on.
const traceSink = (r: object) => {
  try {
    sink(r)
  } catch (e) {
    logger.warn('trace_write_failed', { error: e instanceof Error ? e.message : String(e) })
  }
}
const platform = new Platform({ tenants, logger, traceSink, defaultRateLimitPerMinute: config.defaultRateLimitPerMinute })

const app = express()
app.disable('x-powered-by')
app.use(cors({ origin: config.corsOrigins === '*' ? true : config.corsOrigins }))
app.use(express.json({ limit: config.maxBodyBytes }))
mountPlatformRoutes(app, platform, { logger, tenantErrors: errors, configProblems: problems })

const server = app.listen(config.port, () => {
  logger.info('listening', { port: config.port, tenants: tenants.size, llm: platform.llm.provider, cache: platform.cache.stats().backend, node_env: config.nodeEnv })
})
const shutdown = (sig: string) => {
  logger.info('shutdown', { signal: sig })
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 5000).unref()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
