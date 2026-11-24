import { Activity, CalendarCheck, Inbox, Menu, Mic, Moon, Search, Settings, Sun } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as RKE } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import './console.css'
import { brand, tenantList, tenants } from './engine'
import { TestCallView } from './TestCallView'
import { ConsoleState, initialTheme, statusOf, useConsole, type Theme } from './state'
import { initials } from './ui'
import { BookingsView, InboxView, LiveView, SettingsView, useSampleRun } from './views'

const SECTIONS = [
  { id: 'live', label: 'Live calls', key: '1', icon: <Activity size={15} /> },
  { id: 'inbox', label: 'Inbox', key: '2', icon: <Inbox size={15} /> },
  { id: 'bookings', label: 'Bookings', key: '3', icon: <CalendarCheck size={15} /> },
  { id: 'test', label: 'Test call', key: '4', icon: <Mic size={15} /> },
  { id: 'settings', label: 'Settings', key: '5', icon: <Settings size={15} /> },
] as const
type Section = (typeof SECTIONS)[number]['id']
const isTyping = (e: KeyboardEvent) => { const el = e.target as HTMLElement; return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) }

function Palette({ onClose, onPick, section }: { onClose: () => void; onPick: (id: string) => void; section: Section }) {
  const [q, setQ] = useState('')
  const [i, setI] = useState(0)
  const list = useMemo(() => tenantList.filter((t) => `${brand(t)} ${t.vertical} ${t.locations[0]?.address ?? ''}`.toLowerCase().includes(q.toLowerCase())), [q])
  const onKey = (e: RKE) => {
    if (e.key === 'Escape') onClose()
    if (e.key === 'ArrowDown') { e.preventDefault(); setI((x) => Math.min(list.length - 1, x + 1)) }
    if (e.key === 'ArrowUp') { e.preventDefault(); setI((x) => Math.max(0, x - 1)) }
    if (e.key === 'Enter' && list[i]) onPick(list[i].id)
  }
  return (
    <div className="ov" onMouseDown={onClose}>
      <div className="pal" role="dialog" aria-label="Switch business" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKey}>
        <input autoFocus placeholder={`Switch business (20) · opens ${section}`} value={q} onChange={(e) => { setQ(e.target.value); setI(0) }} aria-controls="sb-pal-list" />
        <ul id="sb-pal-list" role="listbox">
          {!list.length && <li className="g">No business matches “{q}”.</li>}
          {list.map((t, j) => (
            <li key={t.id}>
              {(j === 0 || list[j - 1].vertical !== t.vertical) && <div className="g">{t.vertical === 'hotel' ? 'Hotels' : 'Dental clinics'}</div>}
              <button role="option" aria-selected={j === i} onMouseEnter={() => setI(j)} onClick={() => onPick(t.id)}>
                <span className="sb-tenant" style={{ all: 'unset', display: 'contents' }}><i style={{ width: 20, height: 20, borderRadius: 5, background: 'var(--acc-bg)', color: 'var(--acc-t)', display: 'grid', placeItems: 'center', font: '600 9.5px Inter', fontStyle: 'normal' }}>{initials(t)}</i></span>
                <span>{brand(t)}</span><em>{t.locations[0]?.address.split(',').at(-1)?.trim()}</em>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

function Help({ onClose }: { onClose: () => void }) {
  const rows: Array<[string, string[]]> = [['Switch business', ['⌘', 'K']], ['Go to section', ['1', '–', '5']], ['Test call', ['T']], ['Run sample calls (Live)', ['R']], ['Next / previous call', ['J', 'K']], ['Back to list', ['Esc']], ['Toggle dark mode', ['D']], ['Focus composer', ['/']], ['This help', ['?']]]
  return <div className="ov" onMouseDown={onClose}><div className="help" role="dialog" aria-label="Keyboard shortcuts" onMouseDown={(e) => e.stopPropagation()}><h2>Keyboard shortcuts</h2>{rows.map(([l, k]) => <div className="r" key={l}><span>{l}</span><span>{k.map((x, i) => (x === '–' ? <span key={i}> – </span> : <kbd key={i} style={{ marginLeft: 4 }}>{x}</kbd>))}</span></div>)}</div></div>
}

function Shell() {
  const { tenantId = '', section: rawSection = 'live', callId } = useParams()
  const section = (SECTIONS.some((s) => s.id === rawSection) ? rawSection : 'live') as Section
  const nav = useNavigate()
  const { calls } = useConsole()
  const [theme, setTheme] = useState<Theme>(initialTheme)
  const [pal, setPal] = useState(false)
  const [help, setHelp] = useState(false)
  const [menu, setMenu] = useState(false)
  const valid = tenants.has(tenantId)
  const { run } = useSampleRun(valid ? tenantId : tenantList[0].id)
  const mine = calls.filter((c) => c.tenantId === tenantId)
  const refs = useRef({ mine, section, callId, run })
  useEffect(() => { refs.current = { mine, section, callId, run } })
  useEffect(() => { localStorage.setItem('sb-theme', theme) }, [theme])
  useEffect(() => { document.title = `${valid ? brand(tenants.get(tenantId)!) + ' · ' : ''}Front Desk Ops` }, [tenantId, valid])
  const go = useCallback((s: Section, id?: string) => { setMenu(false); nav(`/app/${tenantId}/${s}${id ? `/${id}` : ''}`) }, [nav, tenantId])

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPal((p) => !p); return }
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return
      const { mine, section, callId, run } = refs.current
      const s = SECTIONS.find((x) => x.key === e.key)
      if (s) return go(s.id)
      if (e.key === '?') return setHelp((x) => !x)
      if (e.key === 't') return go('test')
      if (e.key === 'd') return setTheme((x) => (x === 'dark' ? 'light' : 'dark'))
      if (e.key === 'r' && section === 'live') return void run()
      if (e.key === '/') { const el = document.getElementById('sb-input'); if (el) { e.preventDefault(); el.focus() } return }
      if (e.key === 'Escape') { setHelp(false); setPal(false); if (callId && (section === 'inbox' || section === 'live')) go(section) ; return }
      if ((e.key === 'j' || e.key === 'k') && (section === 'inbox' || section === 'live')) {
        const list = section === 'inbox' ? mine.filter((c) => c.turns.length) : mine
        if (!list.length) return
        const idx = Math.max(0, list.findIndex((c) => c.id === callId))
        const next = list[Math.min(list.length - 1, Math.max(0, idx + (e.key === 'j' ? (callId ? 1 : 0) : -1)))]
        go(section, next.id)
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [go])

  if (!valid) return <Navigate to={`/app/${tenantList[0].id}/live`} replace />
  const t = tenants.get(tenantId)!
  const liveCount = mine.filter((c) => statusOf(c) === 'live').length
  const counts: Partial<Record<Section, number>> = { inbox: mine.filter((c) => c.turns.length).length }
  const hotels = tenantList.filter((x) => x.vertical === 'hotel'), dental = tenantList.filter((x) => x.vertical === 'dental')
  const short = (list: typeof tenantList) => { const i = list.findIndex((x) => x.id === tenantId); const base = list.slice(0, 3); return i >= 3 ? [...base.slice(0, 2), list[i]] : base }
  const title = SECTIONS.find((s) => s.id === section)!.label

  return (
    <div className="sb" data-theme={theme}>
      <aside className="sb-side" data-open={menu} aria-label="Sidebar">
        <div className="sb-ws"><i>FD</i><span>Front Desk Ops</span><button className="ib" onClick={() => setTheme((x) => (x === 'dark' ? 'light' : 'dark'))} aria-label="Toggle dark mode (D)" title="Dark mode (D)">{theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}</button></div>
        <button className="sb-search" onClick={() => setPal(true)}><Search size={13} /><span>Switch business…</span><kbd>⌘K</kbd></button>
        <button className="sb-tenant" onClick={() => setPal(true)} aria-label={`Current business: ${brand(t)}. Switch`}><i>{initials(t)}</i><span style={{ minWidth: 0, flex: 1 }}><b>{brand(t)}</b><small>{t.vertical === 'hotel' ? 'Hotel' : 'Dental clinic'} · {t.locations.length} site{t.locations.length > 1 ? 's' : ''}</small></span></button>
        <nav aria-label="Main">
          {SECTIONS.map((s) => (
            <Link key={s.id} className="sb-nv" to={`/app/${tenantId}/${s.id}`} aria-current={section === s.id ? 'page' : undefined} onClick={() => setMenu(false)} title={`${s.label} (${s.key})`}>
              {s.icon}<span>{s.label}</span>
              {s.id === 'live' && liveCount ? <span className="live" aria-label={`${liveCount} live`} /> : counts[s.id] ? <span className="n">{counts[s.id]}</span> : null}
            </Link>
          ))}
        </nav>
        <div className="sb-grp"><span>Hotels · {hotels.length}</span></div>
        {short(hotels).map((x) => <Link key={x.id} className="sb-tn" to={`/app/${x.id}/${section}`} aria-current={x.id === tenantId}>{brand(x)}</Link>)}
        <div className="sb-grp"><span>Dental · {dental.length}</span></div>
        {short(dental).map((x) => <Link key={x.id} className="sb-tn" to={`/app/${x.id}/${section}`} aria-current={x.id === tenantId}>{brand(x)}</Link>)}
        <button className="sb-tn" style={{ border: 0, background: 'none', cursor: 'pointer', color: 'var(--t3)' }} onClick={() => setPal(true)}>All 20 businesses…</button>
        <div className="sb-foot">
          <div className="row"><span className="sb-sample">SAMPLE DATA</span><span>20 fictional businesses</span></div>
          <div className="row"><button className="btn" style={{ height: 24 }} onClick={() => setHelp(true)}>Shortcuts <kbd>?</kbd></button><Link to="/dashboard" style={{ color: 'var(--t3)' }}>Original demo</Link></div>
        </div>
      </aside>
      <main className="sb-main">
        <div className="sb-bar">
          <button className="ib sb-menu" onClick={() => setMenu((m) => !m)} aria-label="Open menu" aria-expanded={menu}><Menu size={16} /></button>
          <span className="crumb hide-sm">{brand(t)}</span><span className="crumb hide-sm">/</span><h1>{title}</h1>
          {section === 'live' && liveCount > 0 && <span className="chip acc">● {liveCount} live</span>}
          <div className="sp" />
          {section !== 'test' && <button className="btn pri" onClick={() => go('test')}>Test call <kbd>T</kbd></button>}
        </div>
        <div className="sb-body">
          {section === 'live' && <LiveView tenantId={tenantId} />}
          {section === 'inbox' && <InboxView tenantId={tenantId} />}
          {section === 'bookings' && <BookingsView tenantId={tenantId} />}
          {section === 'test' && <TestCallView tenantId={tenantId} />}
          {section === 'settings' && <SettingsView tenantId={tenantId} />}
        </div>
      </main>
      {menu && <div className="ov" style={{ zIndex: 14, background: 'rgba(10,10,12,.2)' }} onClick={() => setMenu(false)} />}
      {pal && <Palette section={section} onClose={() => setPal(false)} onPick={(id) => { setPal(false); nav(`/app/${id}/${section}`) }} />}
      {help && <Help onClose={() => setHelp(false)} />}
    </div>
  )
}

export default function ConsoleApp() {
  return <ConsoleState><Shell /></ConsoleState>
}
