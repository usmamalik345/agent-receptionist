/**
 * Console engine: runs the SAME multi-agent orchestrator as the server, inside the browser,
 * over the SAMPLE tenant files in config/tenants/. No backend needed (works as a static Vercel deploy).
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
/** Demo tenants built from real public facts (old ?biz= links land here) are listed first; /app opens the first one. */
export const FEATURED = ['erth-abu-dhabi', 'mm-dental-care']
const rank = (id: string) => (FEATURED.includes(id) ? 0 : 1)
export const tenantList = [...tenants.values()].sort((a, b) => a.vertical.localeCompare(b.vertical) * -1 || rank(a.id) - rank(b.id) || a.name.localeCompare(b.name))

export const platform = new Platform({
  tenants,
  llm: createMockClient({ note: 'browser: offline extractive responder' }),
  config: loadLatencyConfig({}),
  defaultRateLimitPerMinute: 600,
})

export type TurnResult = PlatformTurnResult
export const brand = (t: Tenant) => t.name.replace(/\s*\(SAMPLE\)\s*/i, '')
