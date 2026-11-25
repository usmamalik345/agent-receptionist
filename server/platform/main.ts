/**
 * Production entry for the multi-tenant receptionist API (used by the Dockerfile).
 * Only the platform API: no WhatsApp bridge, no demo routes.
 *   PORT, TENANTS_DIR, LOG_LEVEL, RATE_LIMIT_PER_MINUTE, CORS_ORIGINS, LLM_*, REDIS_URL, TRACE_FILE,
 *   DATABASE_URL, DB_MIGRATE_ON_BOOT, AUTH_SECRET, AUTH_TTL_MIN, COOKIE_SECURE, SEED_* (see README)
 */
import 'dotenv/config'
import cors from 'cors'
import express from 'express'
import { createAuthFromEnv, createPersistence, seedUsersFromEnv } from './bootstrap.ts'
import { loadPlatformEnv } from './config.ts'
import { mountPlatformRoutes } from './http.ts'
import { createLogger } from './logger.ts'
import { Platform } from './orchestrator.ts'
import { loadTenants } from './registry.ts'
import { defaultTraceSink } from '../tracing.ts'
import { createResponseCache } from '../cache.ts'

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
const persistence = await createPersistence(config, logger)
const seeded = await seedUsersFromEnv(persistence.users, tenants)
if (seeded.length) logger.info('users_seeded', { users: seeded })
const auth = createAuthFromEnv(config, persistence.users, logger)
if (!auth) logger.warn('auth_disabled', { note: 'AUTH_SECRET unset: API is open (local/demo only)' })
const platform = new Platform({ tenants, logger, traceSink, cache: createResponseCache(), defaultRateLimitPerMinute: config.defaultRateLimitPerMinute, store: persistence.store, callLog: persistence.callLog })

const app = express()
app.disable('x-powered-by')
// TRUST_PROXY_HOPS=1 behind one proxy / load balancer, so req.ip is the client (login rate limit); 0 = direct
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? 0))
app.use(cors({ origin: config.corsOrigins === '*' ? true : config.corsOrigins, credentials: config.corsOrigins !== '*' }))
app.use(express.json({ limit: config.maxBodyBytes }))
mountPlatformRoutes(app, platform, { logger, tenantErrors: errors, configProblems: problems, auth, dbReady: persistence.dbReady, storage: persistence.storage })

const server = app.listen(config.port, () => {
  logger.info('listening', { port: config.port, tenants: tenants.size, llm: platform.llm.provider, cache: platform.cache.stats().backend, storage: persistence.storage, auth: Boolean(auth), node_env: config.nodeEnv })
})
const shutdown = (sig: string) => {
  logger.info('shutdown', { signal: sig })
  server.close(() => {
    void platform.flush().then(() => persistence.close()).finally(() => process.exit(0))
  })
  setTimeout(() => process.exit(0), 5000).unref()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
