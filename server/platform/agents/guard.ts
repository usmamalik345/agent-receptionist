/**
 * Guard agent (platform): the shared grounding/PII guard plus a cross-tenant leak check.
 * A reply that names another tenant or speaks another tenant's phone number is blocked
 * whatever produced it. Model output with an ungrounded price/time/phone is blocked too.
 */
import { guardReply, SAFE_LINE, type GuardResult } from '../../agents/guard.ts'
import type { AgentReply } from '../protocol.ts'
import type { Tenant } from '../tenant.ts'

export interface LeakIndex {
  /** per tenant id: other tenants' brand names (lowercase) and phone digit strings */
  names: Map<string, string[]>
  phones: Map<string, string[]>
}

const brand = (t: Tenant) => t.name.replace(/\s*\(SAMPLE\)\s*/i, '').toLowerCase()
const digits = (s: string) => s.replace(/\D/g, '')

export function buildLeakIndex(tenants: Iterable<Tenant>): LeakIndex {
  const all = [...tenants]
  const names = new Map<string, string[]>()
  const phones = new Map<string, string[]>()
  for (const t of all) {
    const others = all.filter((o) => o.id !== t.id)
    const own = brand(t)
    // a shared word ("Harbourside" vs "Harbour View Hotel") is fine; only full other brand names count
    names.set(t.id, others.map(brand).filter((n) => n !== own && !own.includes(n)))
    phones.set(t.id, others.flatMap((o) => o.locations.map((l) => digits(l.phone))))
  }
  return { names, phones }
}

export function crossTenantLeaks(text: string, tenantId: string, idx: LeakIndex): string[] {
  const low = text.toLowerCase()
  const d = digits(text)
  const out: string[] = []
  for (const n of idx.names.get(tenantId) ?? []) if (low.includes(n)) out.push(`name:${n}`)
  for (const p of idx.phones.get(tenantId) ?? []) if (p.length >= 10 && d.includes(p)) out.push(`phone:${p.slice(-4)}`)
  return out
}

export interface PlatformGuardResult extends GuardResult {
  crossTenant: string[]
}

export function runGuardAgent(t: Tenant, r: AgentReply, opts: { callerTexts: string[]; callerPhone?: string; leak: LeakIndex; maxChars?: number }): PlatformGuardResult {
  const g = guardReply({
    text: r.text,
    source: r.source === 'llm' ? 'llm' : 'engine',
    grounding: r.source === 'llm' ? r.grounding : [...r.grounding, ...opts.callerTexts, ...t.locations.map((l) => `${l.name} ${l.address} ${l.phone} ${JSON.stringify(l.hours)}`)],
    allowedContacts: [...t.locations.map((l) => l.phone), ...(opts.callerPhone ? [opts.callerPhone] : [])],
    hours: r.source === 'llm' ? t.locations : undefined,
    callerText: opts.callerTexts.at(-1),
    maxChars: opts.maxChars,
  })
  const crossTenant = crossTenantLeaks(r.text, t.id, opts.leak)
  if (crossTenant.length) return { ...g, ok: false, blocked: true, text: SAFE_LINE, crossTenant }
  return { ...g, crossTenant }
}
