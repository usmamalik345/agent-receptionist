import { NavLink, Outlet } from 'react-router-dom'
import { useBusiness, withBizParam } from '../store/BusinessContext'

export function Layout() {
  const { biz, slug, known } = useBusiness()

  if (!known) {
    // BusinessProvider already rendered the picker
    return null
  }

  const links = [
    { to: withBizParam('/dashboard', slug), label: 'Live demo' },
    ...(biz.industry === 'hotel'
      ? [
          { to: withBizParam('/whatsapp-demo', slug), label: 'Guest chat' },
          { to: withBizParam('/pilot', slug), label: 'Pilot pack' },
        ]
      : [
          { to: withBizParam('/whatsapp-demo', slug), label: 'Patient chat' },
          { to: withBizParam('/pilot', slug), label: 'Pilot pack' },
          { to: withBizParam('/record-demo', slug), label: 'Client video' },
        ]),
  ]

  return (
    <div className="min-h-screen flex flex-col">
      <header className="no-print sticky top-0 z-40">
        <div className="max-w-[1240px] mx-auto px-4 pt-4">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-[22px] border border-[var(--border)] bg-[rgba(247,249,251,0.82)] backdrop-blur-xl px-4 py-3 shadow-[var(--shadow-soft)]">
            <div className="flex items-center gap-3 min-w-0">
              <div
                className="w-11 h-11 rounded-2xl text-white flex items-center justify-center shrink-0 font-display text-lg tracking-tight"
                style={{ background: biz.brandColor }}
              >
                {biz.logoText.slice(0, 2)}
              </div>
              <div className="min-w-0">
                <div className="font-display text-lg leading-none truncate" style={{ color: biz.brandColor }}>
                  {biz.name}
                </div>
                <div className="text-[11px] text-[var(--text-muted)] mt-1">
                  AI receptionist · {biz.industry} demo
                </div>
              </div>
              <span className="demo-badge shrink-0">DEMO</span>
            </div>
            <nav className="flex flex-wrap gap-1">
              {links.map((l) => (
                <NavLink
                  key={l.to}
                  to={l.to}
                  className={({ isActive }) =>
                    `px-3.5 py-2 rounded-full text-sm font-medium transition-colors ${
                      isActive
                        ? 'bg-[var(--stage)] text-[var(--stage-text)]'
                        : 'text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-white/70'
                    }`
                  }
                >
                  {l.label}
                </NavLink>
              ))}
            </nav>
          </div>
        </div>
      </header>
      <main className="flex-1 max-w-[1240px] w-full mx-auto px-4 py-6">
        <Outlet />
      </main>
      <footer className="no-print py-5 text-center text-xs text-[var(--text-muted)]">
        {biz.demoBadge || `Sandbox demo · ${biz.name}`}
        {biz.slug === 'erth' && biz.hotelExtras
          ? ` · by ${biz.hotelExtras.seller.name}`
          : ''}
      </footer>
    </div>
  )
}
