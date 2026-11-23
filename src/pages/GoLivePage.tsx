import { useEffect, useMemo, useState } from 'react'
import { CheckCircle2, Circle, ExternalLink, Shield, PhoneForwarded, MessageSquare } from 'lucide-react'
import { Link } from 'react-router-dom'
import { RESORT } from '../config/resort'
import { fetchBridgeHealth, type BridgeHealth } from '../lib/twilioBridge'

type CheckId =
  | 'meta_desk'
  | 'demo_path'
  | 'human_takeover'
  | 'security_pack'
  | 'forward_ask'
  | 'commercial'

const CHECKS: { id: CheckId; title: string; detail: string }[] = [
  {
    id: 'meta_desk',
    title: 'Desk WhatsApp alert works',
    detail: 'Meta Cloud API sends missed-call inquiry to the desk number (live now on your test line).',
  },
  {
    id: 'demo_path',
    title: 'Missed-call → AI → fields path rehearsed',
    detail: 'Dashboard “Start missed-call demo” runs end-to-end without inventing rates or Opera writes.',
  },
  {
    id: 'human_takeover',
    title: 'Human takeover / Claim–Done queue',
    detail: 'Guest can ask for a colleague; ops can Claim and Done tickets.',
  },
  {
    id: 'security_pack',
    title: 'IT security answers written',
    detail: 'Hosting options, retention, no training on client audio, TLS, sandbox vs production — below.',
  },
  {
    id: 'forward_ask',
    title: 'Ask Erth for overflow forward only',
    detail: 'One DID / after-hours forward to your voice webhook. That is the only Erth dependency for Week 1 voice.',
  },
  {
    id: 'commercial',
    title: 'Commercial one-pager ready',
    detail: 'Scope + next step — print from this page.',
  },
]

const LS_KEY = 'erth_golive_checks'

export function GoLivePage() {
  const [bridge, setBridge] = useState<BridgeHealth | null>(null)
  const [checks, setChecks] = useState<Record<CheckId, boolean>>(() => {
    try {
      const raw = localStorage.getItem(LS_KEY)
      if (raw) return { ...emptyChecks(), ...JSON.parse(raw) }
    } catch {
      /* ignore */
    }
    return emptyChecks()
  })

  useEffect(() => {
    fetchBridgeHealth()
      .then(setBridge)
      .catch(() =>
        setBridge({
          ok: false,
          readyToSend: false,
          deskWhatsAppSet: false,
          tip: 'API offline — npm run dev:all',
        }),
      )
  }, [])

  useEffect(() => {
    // Auto-tick desk WA when bridge is live
    if (bridge?.readyToSend && bridge.provider === 'meta') {
      setChecks((c) => ({ ...c, meta_desk: true }))
    }
  }, [bridge?.readyToSend, bridge?.provider])

  useEffect(() => {
    localStorage.setItem(LS_KEY, JSON.stringify(checks))
  }, [checks])

  const doneCount = useMemo(() => Object.values(checks).filter(Boolean).length, [checks])
  const readyPct = Math.round((doneCount / CHECKS.length) * 100)

  const toggle = (id: CheckId) => setChecks((c) => ({ ...c, [id]: !c[id] }))

  return (
    <div className="max-w-3xl mx-auto space-y-5 animate-fade-up print:space-y-4">
      <div className="stage p-6 md:p-8">
        <span className="demo-badge on-stage mb-3 inline-flex">GO-LIVE · PRODUCT SIDE</span>
        <h1 className="font-display text-4xl md:text-5xl text-white leading-tight">
          Start now — not “in two weeks”
        </h1>
        <p className="mt-3 text-[rgba(232,244,242,0.85)] max-w-xl leading-relaxed">
          The 2-week label was for <strong className="text-white">Erth’s call-forward + review</strong>, not because
          the agent is unfinished. Desk WhatsApp + AI capture + human takeover are ready. Voice on their line needs
          one IT forward.
        </p>
        <div className="mt-5 flex flex-wrap items-end gap-4">
          <div>
            <div className="text-xs uppercase tracking-wider text-[rgba(232,244,242,0.6)]">Readiness</div>
            <div className="font-display text-4xl text-white">{readyPct}%</div>
          </div>
          <div className="flex-1 min-w-[160px] h-2 rounded-full bg-white/15 overflow-hidden">
            <div className="h-full bg-[#5eead4] transition-all" style={{ width: `${readyPct}%` }} />
          </div>
          <button className="btn btn-primary no-print" onClick={() => window.print()}>
            Print one-pager
          </button>
        </div>
      </div>

      <section className="panel p-5 space-y-3">
        <h2 className="font-display text-2xl text-[var(--gold-soft)]">Live systems right now</h2>
        <div className="grid sm:grid-cols-2 gap-3 text-sm">
          <StatusCard
            ok={Boolean(bridge?.readyToSend)}
            title="Desk WhatsApp bridge"
            body={
              bridge?.readyToSend
                ? `Ready · ${bridge.provider} → desk number`
                : bridge?.tip || 'Configure Meta token in .env'
            }
          />
          <StatusCard
            ok
            title="AI receptionist brain"
            body="EN/AR · booking fields · FAQ · escalate · Claim/Done · no Opera write"
          />
          <StatusCard
            ok
            title="Voice webhook (when forwarded)"
            body="POST /api/twilio/voice — after-hours answer + desk WhatsApp alert"
          />
          <StatusCard
            ok={false}
            title="Erth PBX / DID forward"
            body="Only Erth can flip this — ask Hany for after-hours overflow target"
          />
        </div>
        <div className="flex flex-wrap gap-2 no-print">
          <Link className="btn btn-ghost text-sm" to="/dashboard">
            Open live demo
          </Link>
          <a className="btn btn-ghost text-sm" href="/api/setup" target="_blank" rel="noreferrer">
            API setup JSON <ExternalLink size={14} />
          </a>
        </div>
      </section>

      <section className="panel p-5 space-y-3">
        <h2 className="font-display text-2xl text-[var(--gold-soft)]">Go-live checklist</h2>
        <p className="text-sm text-[var(--text-muted)]">
          Tick as you finish. Meeting close: “Approve overflow forward — we are otherwise live.”
        </p>
        <ul className="space-y-2">
          {CHECKS.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => toggle(c.id)}
                className="w-full text-left rounded-2xl border border-[var(--border)] bg-white px-4 py-3 flex gap-3 hover:border-[rgba(15,118,110,0.35)] transition-colors"
              >
                {checks[c.id] ? (
                  <CheckCircle2 className="text-[var(--success)] shrink-0 mt-0.5" size={20} />
                ) : (
                  <Circle className="text-[var(--text-muted)] shrink-0 mt-0.5" size={20} />
                )}
                <div>
                  <div className="font-semibold text-[var(--gold-soft)] text-sm">{c.title}</div>
                  <div className="text-xs text-[var(--text-muted)] mt-0.5 leading-relaxed">{c.detail}</div>
                </div>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="panel p-5 space-y-3">
        <h2 className="font-display text-2xl text-[var(--gold-soft)] flex items-center gap-2">
          <PhoneForwarded size={22} /> What Erth must do (10 minutes)
        </h2>
        <ol className="list-decimal pl-5 text-sm text-[var(--text)] space-y-2 leading-relaxed">
          <li>Choose after-hours / overflow only on the reservations number (not all daytime traffic).</li>
          <li>
            Forward unanswered / night calls to the pilot voice number (Twilio or SIP trunk you provide) whose Voice
            webhook is <code className="text-[var(--gold)]">/api/twilio/voice</code>.
          </li>
          <li>Confirm desk WhatsApp number for alerts (ops phone — not guest login).</li>
          <li>Leave Opera write OFF until IT reviews Week 1 metrics.</li>
        </ol>
        <p className="text-xs text-[var(--text-muted)]">
          Until that forward exists, prove the product with dashboard missed-call + real desk WhatsApp (already
          working).
        </p>
      </section>

      <section className="panel p-5 space-y-3">
        <h2 className="font-display text-2xl text-[var(--gold-soft)] flex items-center gap-2">
          <Shield size={22} /> Security pack (say this to IT)
        </h2>
        <ul className="text-sm space-y-2 text-[var(--text-muted)] leading-relaxed">
          <li>
            <strong className="text-[var(--text)]">Sandbox vs production:</strong> today’s UI is labelled DEMO. Production
            = TLS, auth on ops dashboard, audit log of tool calls, separate env secrets.
          </li>
          <li>
            <strong className="text-[var(--text)]">Hosting:</strong> UAE / Gulf region or Erth-approved VPC — confirm in
            pilot kickoff. No guest audio used to train foundation models.
          </li>
          <li>
            <strong className="text-[var(--text)]">Retention:</strong> transcripts + desk alerts retained only for pilot
            window (e.g. 30 days) unless Erth requests longer for QA.
          </li>
          <li>
            <strong className="text-[var(--text)]">Human takeover:</strong> always on — “agent please” creates Claim/Done
            ticket; AI does not invent rates or write Opera.
          </li>
          <li>
            <strong className="text-[var(--text)]">WhatsApp:</strong> desk notifications via Meta Cloud API (test now;
            production WABA + templates under Erth Business Manager).
          </li>
        </ul>
      </section>

      <section className="panel p-5 space-y-3">
        <h2 className="font-display text-2xl text-[var(--gold-soft)] flex items-center gap-2">
          <MessageSquare size={22} /> Commercial one-pager
        </h2>
        <div className="rounded-2xl border border-[rgba(15,118,110,0.35)] bg-[var(--accent-wash)] p-4 text-sm leading-relaxed">
          <strong className="text-[var(--gold-soft)]">Ask tomorrow:</strong> “Approve after-hours overflow forward +
          desk WhatsApp number. Product side is ready now — we measure answer rate and inquiries captured in the first
          14 days, Opera write still off.”
        </div>
        <p className="text-xs text-[var(--text-muted)]">
          Prepared by {RESORT.seller.name} · {RESORT.seller.role} · usmamalik344@gmail.com
        </p>
      </section>
    </div>
  )
}

function emptyChecks(): Record<CheckId, boolean> {
  return {
    meta_desk: false,
    demo_path: false,
    human_takeover: false,
    security_pack: false,
    forward_ask: false,
    commercial: false,
  }
}

function StatusCard({ ok, title, body }: { ok: boolean; title: string; body: string }) {
  return (
    <div className="rounded-2xl border border-[var(--border)] bg-white p-4">
      <div className="flex items-center gap-2 mb-1">
        <span
          className="status-dot"
          style={{ background: ok ? 'var(--success)' : '#c4a35a' }}
        />
        <div className="font-semibold text-sm text-[var(--gold-soft)]">{title}</div>
      </div>
      <p className="text-xs text-[var(--text-muted)] leading-relaxed">{body}</p>
    </div>
  )
}
