/**
 * Tenant registry: loads every config/tenants/*.json (TENANTS_DIR), validates it and
 * keeps it by id. A file that fails validation is reported and NOT loaded (fail closed).
 * `toBusinessConfig` adapts a tenant to the shape the shared retrieval agent indexes.
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { validateTenant, type Tenant } from './tenant.ts'
export { toBusinessConfig } from './tenantAdapter.ts'

export const DEFAULT_TENANTS_DIR = path.resolve(import.meta.dirname, '..', '..', 'config', 'tenants')

export interface LoadResult {
  tenants: Map<string, Tenant>
  errors: Array<{ file: string; problems: string[] }>
}

export function loadTenants(dir = process.env.TENANTS_DIR || DEFAULT_TENANTS_DIR): LoadResult {
  const tenants = new Map<string, Tenant>()
  const errors: LoadResult['errors'] = []
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    let json: unknown
    try {
      json = JSON.parse(readFileSync(path.join(dir, f), 'utf8'))
    } catch (e) {
      errors.push({ file: f, problems: [`invalid JSON: ${e instanceof Error ? e.message : e}`] })
      continue
    }
    const problems = validateTenant(json)
    const t = json as Tenant
    if (!problems.length && tenants.has(t.id)) problems.push(`duplicate id ${t.id}`)
    if (!problems.length && `${t.id}.json` !== f) problems.push(`file name must be ${t.id}.json`)
    if (problems.length) errors.push({ file: f, problems })
    else tenants.set(t.id, Object.freeze(t))
  }
  return { tenants, errors }
}

