/**
 * Env-based config for the platform API, validated at boot. Bad values fail fast with a
 * clear message instead of silently using a wrong setting. Secrets are only read, never logged.
 */
export interface PlatformEnv {
  port: number
  nodeEnv: string
  tenantsDir: string | undefined
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  defaultRateLimitPerMinute: number
  corsOrigins: string[] | '*'
  llmProvider: string
  hasLlmKey: boolean
  redis: boolean
  maxBodyBytes: number
}

export function loadPlatformEnv(env: Record<string, string | undefined> = process.env): { config: PlatformEnv; problems: string[] } {
  const problems: string[] = []
  const int = (k: string, d: number, min = 1, max = 1e9) => {
    const v = env[k]
    if (v === undefined || v === '') return d
    const n = Number(v)
    if (!Number.isInteger(n) || n < min || n > max) { problems.push(`${k} must be an integer ${min}-${max}`); return d }
    return n
  }
  const level = (env.LOG_LEVEL || 'info') as PlatformEnv['logLevel']
  if (!['debug', 'info', 'warn', 'error'].includes(level)) problems.push('LOG_LEVEL must be debug|info|warn|error')
  const provider = (env.LLM_PROVIDER || 'mock').toLowerCase()
  if (!['mock', 'groq', 'gemini', 'openai-compatible'].includes(provider)) problems.push('LLM_PROVIDER must be mock|groq|gemini|openai-compatible')
  const nodeEnv = env.NODE_ENV || 'development'
  const cors = env.CORS_ORIGINS ? env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean) : '*'
  if (nodeEnv === 'production' && cors === '*') problems.push('CORS_ORIGINS must be set in production (comma-separated origins)')
  return {
    problems,
    config: {
      port: int('PORT', 8787, 1, 65535),
      nodeEnv,
      tenantsDir: env.TENANTS_DIR || undefined,
      logLevel: level,
      defaultRateLimitPerMinute: int('RATE_LIMIT_PER_MINUTE', 120),
      corsOrigins: cors,
      llmProvider: provider,
      hasLlmKey: Boolean(env.LLM_API_KEY),
      redis: Boolean(env.REDIS_URL),
      maxBodyBytes: int('MAX_BODY_BYTES', 16_384, 1024, 1_000_000),
    },
  }
}
