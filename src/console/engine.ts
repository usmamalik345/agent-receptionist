/**
 * Console engine: runs the SAME multi-agent orchestrator as the server, inside the browser,
 * over the 20 SAMPLE tenant files. No backend needed (works as a static Vercel deploy).
 * Open questions use the offline extractive responder (no API key ever goes to a browser).
 */
import { createMockClient } from '../../server/llm.ts'
import { loadLatencyConfig } from '../../server/latency.ts'
import { Platform, type PlatformTurnResult } from '../../server/platform/orchestrator.ts'
import { validateTenant, type Tenant } from '../../server/platform/tenant.ts'

const files = import.meta.glob('../../config/tenants/*.json', { eager: true, import: 'default' }) as Record<string, unknown>

export const tenants = new Map<string, Tenant>()
for (const json of Object.values(files)) {
  if (validateTenant(json).length === 0) tenants.set((json as Tenant).id, json as Tenant)
}
export const tenantList = [...tenants.values()].sort((a, b) => a.vertical.localeCompare(b.vertical) * -1 || a.name.localeCompare(b.name))

export const platform = new Platform({
  tenants,
  llm: createMockClient({ note: 'browser: offline extractive responder' }),
  config: loadLatencyConfig({}),
  defaultRateLimitPerMinute: 600,
})

export type TurnResult = PlatformTurnResult
export const brand = (t: Tenant) => t.name.replace(/\s*\(SAMPLE\)\s*/i, '')
