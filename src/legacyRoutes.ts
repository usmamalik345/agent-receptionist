/**
 * Old public links (shared on LinkedIn, the portfolio site, proposals) -> the new console.
 * Pure function so it is unit-tested (tests/legacy-routes.test.ts) and used by the SPA router.
 *
 *   /dashboard?biz=erth       -> /app/erth-abu-dhabi/test
 *   /dashboard?biz=mm-dental  -> /app/mm-dental-care/test
 *   /dashboard                -> /app/erth-abu-dhabi/test   (Erth was the old default business)
 *   /whatsapp-demo, /record-demo, /run-of-show -> test call;  /go-live -> settings;  /pilot -> live
 *   /                         -> /app (or the ?biz= tenant's test call)
 * Unknown ?biz= values fall back to /app. Other query params (utm_*, etc.) are kept.
 */

/** Old ?biz= slug (src/businesses/index.ts) -> tenant id in config/tenants/ */
export const LEGACY_BIZ_TO_TENANT: Readonly<Record<string, string>> = {
  erth: 'erth-abu-dhabi',
  'mm-dental': 'mm-dental-care',
}
/** Old default business (DEFAULT_BUSINESS_SLUG = 'erth') */
export const LEGACY_DEFAULT_TENANT = LEGACY_BIZ_TO_TENANT.erth

type Section = 'live' | 'inbox' | 'bookings' | 'test' | 'settings'
const PAGE_SECTION: Readonly<Record<string, Section>> = {
  '/dashboard': 'test',
  '/whatsapp-demo': 'test',
  '/record-demo': 'test',
  '/run-of-show': 'test',
  '/go-live': 'settings',
  '/pilot': 'live',
}
export const LEGACY_PATHS = ['/', ...Object.keys(PAGE_SECTION)] as const

/** Returns the new URL for an old path, or null if the path is not a legacy route. */
export function legacyTarget(pathname: string, search: string, knownTenant: (id: string) => boolean): string | null {
  const path = pathname.replace(/\/+$/, '') || '/'
  if (path !== '/' && !(path in PAGE_SECTION)) return null
  const q = new URLSearchParams(search)
  const biz = (q.get('biz') ?? '').trim().toLowerCase()
  q.delete('biz')
  const rest = q.toString() ? `?${q}` : ''
  const fromBiz = biz ? LEGACY_BIZ_TO_TENANT[biz] ?? (knownTenant(biz) ? biz : null) : null
  if (path === '/') return fromBiz ? `/app/${fromBiz}/test${rest}` : `/app${rest}`
  const tenant = biz ? fromBiz : LEGACY_DEFAULT_TENANT
  if (!tenant || !knownTenant(tenant)) return `/app${rest}`
  return `/app/${tenant}/${PAGE_SECTION[path]}${rest}`
}
