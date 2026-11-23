import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from 'react'
import { useSearchParams } from 'react-router-dom'
import type { BusinessConfig } from '../config/businessTypes'
import type { IndustryPreset } from '../config/businessTypes'
import {
  DEFAULT_BUSINESS_SLUG,
  getBusiness,
  getPresetForBusiness,
  listBusinesses,
} from '../businesses'
import { setActiveBusiness } from '../lib/businessRuntime'
import { setDemoStorageSlug } from '../lib/storage'

interface BusinessContextValue {
  biz: BusinessConfig
  preset: IndustryPreset
  slug: string
  known: boolean
  available: BusinessConfig[]
}

const BusinessContext = createContext<BusinessContextValue | null>(null)

export function BusinessProvider({ children }: { children: ReactNode }) {
  const [params] = useSearchParams()
  const raw = params.get('biz')
  const slug = raw?.trim() || DEFAULT_BUSINESS_SLUG
  const resolved = getBusiness(slug)
  const biz = resolved ?? getBusiness(DEFAULT_BUSINESS_SLUG)!
  const available = listBusinesses()

  // Sync module-level runtime before children mount (storage + conversation engine)
  setActiveBusiness(biz)
  setDemoStorageSlug(biz.slug)

  useEffect(() => {
    setActiveBusiness(biz)
    setDemoStorageSlug(biz.slug)
    document.documentElement.style.setProperty('--brand', biz.brandColor)
    document.title = `${biz.name} — AI Receptionist Demo`
  }, [biz])

  const value = useMemo<BusinessContextValue>(
    () => {
      const known = Boolean(resolved) || !raw
      return {
        biz,
        preset: getPresetForBusiness(biz),
        slug: known ? biz.slug : slug,
        known,
        available,
      }
    },
    [biz, slug, resolved, available, raw],
  )

  // Unknown slug → picker (still provide default biz for children that mount briefly)
  if (raw && !resolved) {
    return (
      <BusinessContext.Provider value={{ ...value, known: false, slug }}>
        <BusinessPicker available={available} attempted={slug} />
      </BusinessContext.Provider>
    )
  }

  return <BusinessContext.Provider value={value}>{children}</BusinessContext.Provider>
}

function BusinessPicker({
  available,
  attempted,
}: {
  available: BusinessConfig[]
  attempted: string
}) {
  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="panel max-w-lg w-full p-8 space-y-5">
        <div>
          <p className="text-xs uppercase tracking-wide text-[var(--text-muted)]">Unknown business</p>
          <h1 className="font-display text-3xl text-[var(--gold-soft)] mt-1">Choose a demo</h1>
          <p className="text-sm text-[var(--text-muted)] mt-2">
            No config for <code className="text-[var(--text)]">?biz={attempted}</code>. Pick one below.
          </p>
        </div>
        <ul className="space-y-2">
          {available.map((b) => (
            <li key={b.slug}>
              <a
                className="flex items-center gap-3 rounded-2xl border border-[var(--border)] px-4 py-3 hover:bg-white/70 transition-colors"
                href={`/?biz=${b.slug}`}
                style={{ borderColor: `${b.brandColor}44` }}
              >
                <span
                  className="w-10 h-10 rounded-xl flex items-center justify-center text-white text-sm font-display"
                  style={{ background: b.brandColor }}
                >
                  {b.logoText.slice(0, 2)}
                </span>
                <span>
                  <span className="block font-medium">{b.name}</span>
                  <span className="text-xs text-[var(--text-muted)]">
                    {b.industry} · ?biz={b.slug}
                  </span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

export function useBusiness(): BusinessContextValue {
  const ctx = useContext(BusinessContext)
  if (!ctx) throw new Error('useBusiness must be used within BusinessProvider')
  return ctx
}

/** Preserve ?biz= across in-app links */
export function withBizParam(path: string, slug: string): string {
  const [base, hash] = path.split('#')
  const url = new URL(base, 'http://local')
  if (slug && slug !== DEFAULT_BUSINESS_SLUG) url.searchParams.set('biz', slug)
  const q = url.searchParams.toString()
  return `${url.pathname}${q ? `?${q}` : ''}${hash ? `#${hash}` : ''}`
}
