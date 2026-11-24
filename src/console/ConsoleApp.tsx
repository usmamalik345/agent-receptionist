import { CalendarCheck, ChevronsUpDown, Inbox, Menu, MessageSquare, Moon, Settings, Sun } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Link, Navigate, NavLink, useNavigate, useParams } from 'react-router-dom'
import './console.css'
import { ChatView } from './ChatView'
import { brand, tenantList, tenants } from './engine'
import { BookingsView, firstTenantId, InboxView, SettingsView } from './OtherViews'
import { ConsoleState, initialTheme, useConsole, type Theme } from './state'
import { Avatar } from './ui'

function TenantSwitcher({ tenantId, section }: { tenantId: string; section: string }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const nav = useNavigate()
  const ref = useRef<HTMLDivElement>(null)
  const t = tenants.get(tenantId)!
  const list = useMemo(() => tenantList.filter((x) => brand(x).toLowerCase().includes(q.toLowerCase())), [q])
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  const choose = (id: string) => { setOpen(false); setQ(''); nav(`/app/${id}/${section === 'inbox' ? 'inbox' : section}`) }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') setOpen(false)
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(list.length - 1, a + 1)) }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)) }
    if (e.key === 'Enter' && list[active]) { e.preventDefault(); choose(list[active].id) }
  }
  return (
    <div className="cx-switch" ref={ref} onKeyDown={onKey}>
      <button type="button" onClick={() => { setOpen((o) => !o); setActive(0) }} aria-haspopup="listbox" aria-expanded={open}>
        <Avatar t={t} />
        <span style={{ minWidth: 0, flex: 1 }}><span className="name" style={{ display: 'block' }}>{brand(t)}</span><span className="sub">{t.vertical === 'hotel' ? 'Hotel' : 'Dental clinic'} · Sample</span></span>
        <ChevronsUpDown size={15} color="var(--text-3)" />
      </button>
      {open && (
        <div className="cx-pop">
          <label className="sr" htmlFor="cx-tq">Search businesses</label>
          <input id="cx-tq" autoFocus placeholder="Search 20 businesses…" value={q} onChange={(e) => { setQ(e.target.value); setActive(0) }} />
          <ul role="listbox" aria-label="Businesses">
            {list.length === 0 && <li className="cx-note" style={{ padding: 8 }}>No match.</li>}
            {list.map((x, i) => {
              const g = x.vertical === 'hotel' ? 'Hotels' : 'Dental clinics'
              const head = i === 0 || list[i - 1].vertical !== x.vertical ? g : null
              return (
                <li key={x.id}>
                  {head && <div className="group">{head}</div>}
                  <button type="button" role="option" aria-selected={i === active} onClick={() => choose(x.id)} onMouseEnter={() => setActive(i)}>
                    <Avatar t={x} /> <span>{brand(x)}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}

function Shell() {
  const { tenantId = '', section = 'chat' } = useParams()
  const { calls } = useConsole()
  const [theme, setTheme] = useState<Theme>(initialTheme)
  const [menu, setMenu] = useState(false)
  useEffect(() => { localStorage.setItem('cx-theme', theme) }, [theme])
  useEffect(() => { document.title = 'Receptionist console'; setMenu(false) }, [tenantId, section])
  if (!tenants.has(tenantId)) return <Navigate to={`/app/${firstTenantId}/chat`} replace />
  const convCount = calls.filter((c) => c.tenantId === tenantId && c.messages.length > 1).length
  const item = (to: string, icon: React.ReactNode, label: string, count?: number) => (
    <NavLink to={`/app/${tenantId}/${to}`}>{icon}<span>{label}</span>{count ? <span className="count">{count}</span> : null}</NavLink>
  )
  return (
    <div className="cx" data-theme={theme}>
      <aside className="cx-side" data-open={menu} aria-label="Sidebar">
        <div className="cx-brand"><span className="cx-mark">R</span>Receptionist</div>
        <TenantSwitcher tenantId={tenantId} section={section} />
        <nav className="cx-nav" aria-label="Main">
          {item('chat', <MessageSquare size={16} />, 'Test call')}
          {item('inbox', <Inbox size={16} />, 'Conversations', convCount)}
          {item('bookings', <CalendarCheck size={16} />, 'Bookings')}
          {item('settings', <Settings size={16} />, 'Settings')}
        </nav>
        <div className="cx-side-foot">
          <button className="cx-btn ghost" type="button" onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))} aria-label="Toggle dark mode">
            {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />} {theme === 'dark' ? 'Light mode' : 'Dark mode'}
          </button>
          <Link className="cx-btn ghost" to="/dashboard">Original demo</Link>
          <p className="cx-note">All 20 businesses are fictional SAMPLE data.</p>
        </div>
      </aside>
      <main className="cx-main">
        <button className="cx-icon-btn cx-menu-btn" style={{ position: 'absolute', top: 10, left: 8, zIndex: 5 }} type="button" onClick={() => setMenu((m) => !m)} aria-label="Open menu"><Menu size={18} /></button>
        <div className="cx-body" style={{ display: 'flex', flexDirection: 'column' }}>
          {section === 'chat' && <ChatView tenantId={tenantId} />}
          {section === 'inbox' && <InboxView tenantId={tenantId} />}
          {section === 'bookings' && <BookingsView tenantId={tenantId} />}
          {section === 'settings' && <SettingsView tenantId={tenantId} />}
        </div>
      </main>
    </div>
  )
}

export default function ConsoleApp() {
  return <ConsoleState><Shell /></ConsoleState>
}
