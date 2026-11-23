import { Download, Lock, Pause, Play, Search, Shield } from 'lucide-react'
import { useMemo, useState } from 'react'
import { KNOWLEDGE, matchFaq, type FaqKey } from '../config/knowledge'
import { exportDemoCsv, exportDemoJson } from '../lib/exportDemo'
import { findGuestProfile } from '../lib/guestMemory'
import { useDemo } from '../store/DemoContext'

export function ItOpsPanel() {
  const demo = useDemo()
  const { settings, auditLog, history, tickets, guestProfiles, session } = demo
  const paused = settings.aiPaused

  const metrics = useMemo(() => {
    const inquiries = history.filter(
      (h) => h.outcome === 'booked_inquiry' || h.outcome === 'after_hours_saved',
    ).length
    const transferred = history.filter((h) => h.outcome === 'transferred').length
    const callbacks = history.filter((h) => h.outcome === 'callback_requested').length
    const faqTurns = session.toolLogs.filter(
      (l) => l.tool === 'detect_intent' && /faq|greeting/i.test(String(l.result) + String(l.args?.intent || '')),
    ).length
    const openHigh = tickets.filter((t) => t.status !== 'done' && t.priority === 'high').length
    const total = Math.max(1, history.length)
    const containRate = Math.round(((inquiries + callbacks) / total) * 100)
    return { inquiries, transferred, callbacks, faqTurns, openHigh, containRate, total: history.length }
  }, [history, tickets, session.toolLogs])

  return (
    <div className="panel p-4 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-display text-xl text-[var(--gold-soft)] flex items-center gap-2">
            <Shield size={18} /> IT ops &amp; pilot controls
          </h2>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">
            Kill switch · audit · export · metrics — sandbox only, no live Opera
          </p>
        </div>
        <span className="demo-badge">DEMO</span>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={`btn text-sm ${paused ? 'btn-primary' : 'btn-light'}`}
          onClick={() => demo.setSettings({ aiPaused: !paused })}
        >
          {paused ? <Play size={14} /> : <Pause size={14} />}
          {paused ? 'Resume AI' : 'Pause AI (kill switch)'}
        </button>
        <button
          type="button"
          className="btn btn-ghost text-sm"
          onClick={() => exportDemoJson(demo)}
        >
          <Download size={14} /> Export JSON
        </button>
        <button
          type="button"
          className="btn btn-ghost text-sm"
          onClick={() => exportDemoCsv(demo)}
        >
          <Download size={14} /> Export CSV
        </button>
      </div>

      {paused && (
        <p className="text-sm text-[var(--danger)] font-medium">
          AI paused — guest messages open high-priority tickets for the desk.
        </p>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <Metric label="Contain %" value={`${metrics.containRate}%`} tip="Inquiries+callbacks / calls" />
        <Metric label="Inquiries" value={String(metrics.inquiries)} />
        <Metric label="Handoffs" value={String(metrics.transferred)} />
        <Metric label="High tickets" value={String(metrics.openHigh)} />
      </div>

      <div>
        <h3 className="text-xs uppercase tracking-wide text-[var(--text-muted)] mb-2">Audit trail</h3>
        {auditLog.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)]">No IT events yet — toggle kill switch or complete an inquiry.</p>
        ) : (
          <ul className="max-h-40 overflow-y-auto space-y-1.5 text-xs">
            {auditLog.slice(0, 12).map((e) => (
              <li key={e.id} className="flex gap-2 border-b border-[var(--border)]/50 pb-1">
                <span className="text-[var(--text-muted)] whitespace-nowrap">
                  {new Date(e.timestamp).toLocaleTimeString()}
                </span>
                <span className="font-semibold text-[var(--gold)]">{e.actor}</span>
                <span className="text-[var(--text)] truncate">
                  {e.action}: {e.detail}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {guestProfiles.length > 0 && (
        <div>
          <h3 className="text-xs uppercase tracking-wide text-[var(--text-muted)] mb-2">
            Returning guests ({guestProfiles.length})
          </h3>
          <ul className="text-xs space-y-1">
            {guestProfiles.slice(0, 5).map((g) => (
              <li key={g.phoneDigits} className="flex justify-between gap-2">
                <span>
                  {g.guestName} · +{g.phoneDigits} · {g.visitCount}×
                </span>
                <button
                  type="button"
                  className="text-[var(--gold)] underline"
                  onClick={() => demo.recallGuestByPhone(g.phoneDigits)}
                >
                  Recall
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function Metric({ label, value, tip }: { label: string; value: string; tip?: string }) {
  return (
    <div className="rounded border border-[var(--border)] px-3 py-2" title={tip}>
      <div className="text-[10px] uppercase text-[var(--text-muted)]">{label}</div>
      <div className="font-display text-xl text-[var(--gold-soft)]">{value}</div>
    </div>
  )
}

export function OperaGatePanel() {
  const demo = useDemo()
  const { settings } = demo
  const [confirmWrite, setConfirmWrite] = useState(false)

  return (
    <div className="panel p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="font-display text-xl text-[var(--gold-soft)] flex items-center gap-2">
            <Lock size={18} /> Opera / PMS gate
          </h2>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">
            IT-controlled connectors — demo stubs only
          </p>
        </div>
        <span className="demo-badge">SANDBOX</span>
      </div>

      <div className="grid sm:grid-cols-2 gap-3 text-sm">
        <div className="rounded border border-[var(--border)] p-3">
          <div className="text-[10px] uppercase text-[var(--text-muted)]">Availability read</div>
          <div className="font-semibold mt-1">
            {settings.operaReadEnabled ? 'ON · sandbox stub' : 'OFF'}
          </div>
          <button
            type="button"
            className="btn btn-ghost text-xs mt-2"
            onClick={() => demo.setSettings({ operaReadEnabled: !settings.operaReadEnabled })}
          >
            {settings.operaReadEnabled ? 'Disable read' : 'Enable sandbox read'}
          </button>
        </div>
        <div className="rounded border border-[var(--border)] p-3">
          <div className="text-[10px] uppercase text-[var(--text-muted)]">Booking write-back</div>
          <div className={`font-semibold mt-1 ${settings.operaWriteUnlocked ? 'text-[var(--success)]' : 'text-[var(--danger)]'}`}>
            {settings.operaWriteUnlocked ? 'UNLOCKED (demo flag)' : 'LOCKED'}
          </div>
          {!settings.operaWriteUnlocked ? (
            <button
              type="button"
              className="btn btn-light text-xs mt-2"
              onClick={() => setConfirmWrite(true)}
            >
              Request IT unlock…
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-ghost text-xs mt-2"
              onClick={() => demo.setSettings({ operaWriteUnlocked: false })}
            >
              Re-lock write
            </button>
          )}
        </div>
      </div>

      {confirmWrite && (
        <div className="rounded border border-[rgba(185,28,28,0.35)] bg-[rgba(185,28,28,0.06)] p-3 text-sm space-y-2">
          <p>
            Unlocking write does <strong>not</strong> connect to live Opera in this demo. It only
            shows the IT approval gate for IT review.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              className="btn btn-primary text-xs"
              onClick={() => {
                demo.setSettings({ operaWriteUnlocked: true })
                setConfirmWrite(false)
              }}
            >
              Confirm unlock (demo)
            </button>
            <button type="button" className="btn btn-ghost text-xs" onClick={() => setConfirmWrite(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <p className="text-xs text-[var(--text-muted)] leading-relaxed">
        AI still never invents rates. Desk WhatsApp gets the inquiry either way. Live PMS write needs
        weekly IT sign-off in production.
      </p>
    </div>
  )
}

export function KnowledgeSearchPanel() {
  const [q, setQ] = useState('')
  const demo = useDemo()
  const lang = demo.settings.language

  const hit = useMemo(() => {
    if (!q.trim()) return null
    return matchFaq(q)
  }, [q])

  const answer = hit ? KNOWLEDGE[hit as FaqKey] : null

  return (
    <div className="panel p-4 space-y-3">
      <div>
        <h2 className="font-display text-xl text-[var(--gold-soft)] flex items-center gap-2">
          <Search size={18} /> Knowledge search
        </h2>
        <p className="text-xs text-[var(--text-muted)] mt-0.5">
          Controlled FAQ corpus — not an open LLM. Source: erth.ae public facts.
        </p>
      </div>
      <input
        className="soft-input w-full"
        placeholder="Try: parking, airport, breakfast, spa hours…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {q.trim() && !hit && (
        <p className="text-sm text-[var(--text-muted)]">
          No FAQ match — AI would clarify or escalate (not invent).
        </p>
      )}
      {answer && hit && (
        <div className="rounded border border-[var(--border)] p-3 space-y-2 text-sm">
          <div className="text-[10px] uppercase tracking-wide text-[var(--gold)]">
            Matched key: {hit} · source: knowledge / erth.ae
          </div>
          <p dir={lang === 'ar' ? 'rtl' : 'ltr'}>{lang === 'ar' ? answer.ar : answer.en}</p>
        </div>
      )}
    </div>
  )
}

/** Chip for dashboard when phone matches a known guest */
export function ReturningGuestHint() {
  const demo = useDemo()
  const phone = demo.session.booking.phone
  const profile = phone ? findGuestProfile(demo.guestProfiles, phone) : null
  if (!profile) return null
  return (
    <div className="panel px-4 py-2 text-sm flex flex-wrap items-center gap-2 border-[rgba(15,118,110,0.35)]">
      <span className="demo-badge">Returning guest</span>
      <span>
        {profile.guestName} · {profile.visitCount} prior inquiries
        {profile.lastCheckIn ? ` · last ${profile.lastCheckIn}` : ''}
      </span>
      <button
        type="button"
        className="btn btn-ghost text-xs ml-auto"
        onClick={() => demo.recallGuestByPhone(profile.phoneDigits)}
      >
        Say welcome back
      </button>
    </div>
  )
}
