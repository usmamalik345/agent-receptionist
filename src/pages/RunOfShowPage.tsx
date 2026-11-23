import { CheckCircle2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { RESORT } from '../config/resort'

const SEGMENTS = [
  {
    clock: '0:00–3:00',
    title: 'Intro + company profile',
    say: `“Hany, thank you for the time. I’m Usama, independent AI engineer for Gulf hospitality. You asked for product detail, a company profile, and prior work — I’ll start with a short profile on /pilot, then a live DEMO sandbox for after-hours and overflow reservations.”`,
  },
  {
    clock: '3:00–6:00',
    title: 'Confirm pain',
    say: `“When we connected, the issue was missed reservation calls outside peak staffing — after-hours and overflow losing stays. Does that still match what IT and reservations see on the line?”`,
  },
  {
    clock: '6:00–14:00',
    title: 'Live voice demo',
    say: `Open /dashboard → “Missed call → AI” (desk not answering banner → AI covers → desk WhatsApp notify). Backup: Sample call EN. Point transcript, fields, Staff Claim/Done.`,
  },
  {
    clock: '14:00–18:00',
    title: 'WhatsApp + safety paths',
    say: `Open /whatsapp-demo (second window). Same booking brain. Show “agent please” ticket, or Booking.com / change-booking callback (never claims live change). Optional: airport FAQ or unlabeled multi-field dump.`,
  },
  {
    clock: '18:00–24:00',
    title: 'Architecture + security',
    say: `Open /pilot. Walk Guest → Voice/WhatsApp AI → Dashboard → Desk notify → optional PMS. Stress Week 1–3 roadmap: sandbox today; production TLS, access control, audit logs, retention, Gulf hosting options, no training on client audio without consent, human takeover always on.`,
  },
  {
    clock: '24:00–30:00',
    title: 'Pilot ask',
    say: `“Proposed pilot: one reservations line, after-hours and overflow only, two weeks. Day 1 setup, day 3 live, day 14 review. Metrics: answer rate, inquiries captured, handoff time. Next step: share PBX/SIP or call-forward method. Pricing is draft on the pilot page — I’ll confirm numbers after scope.”`,
  },
]

export function RunOfShowPage() {
  const [elapsed, setElapsed] = useState(0)
  const [running, setRunning] = useState(false)
  const [done, setDone] = useState<Record<number, boolean>>({})

  useEffect(() => {
    if (!running) return
    const id = setInterval(() => setElapsed((e) => e + 1), 1000)
    return () => clearInterval(id)
  }, [running])

  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0')
  const ss = String(elapsed % 60).padStart(2, '0')

  return (
    <div className="max-w-3xl mx-auto space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <span className="demo-badge">MEETING RUN-OF-SHOW</span>
          <h1 className="font-display text-4xl text-[var(--gold-soft)] mt-2">Sales meeting checklist</h1>
          <p className="text-sm text-[var(--text-muted)] mt-1">
            ~30 minutes · {RESORT.seller.name} ↔ IT Director · Keep /dashboard screen-shared
          </p>
        </div>
        <div className="panel px-4 py-3 text-center min-w-[120px]">
          <div className="text-xs text-[var(--text-muted)]">Timer</div>
          <div className="font-display text-3xl text-[var(--gold-soft)] tabular-nums">
            {mm}:{ss}
          </div>
          <div className="flex gap-1 mt-2 justify-center">
            <button className="btn btn-primary text-xs py-1" onClick={() => setRunning(true)}>
              Start
            </button>
            <button className="btn btn-secondary text-xs py-1" onClick={() => setRunning(false)}>
              Pause
            </button>
            <button
              className="btn btn-danger text-xs py-1"
              onClick={() => {
                setRunning(false)
                setElapsed(0)
              }}
            >
              Reset
            </button>
          </div>
        </div>
      </div>

      <div className="panel p-4 text-sm space-y-1">
        <div className="font-medium text-[var(--gold-soft)]">Quick links</div>
        <div className="flex flex-wrap gap-2">
          <Link className="btn btn-secondary text-xs" to="/dashboard">
            Dashboard
          </Link>
          <Link className="btn btn-secondary text-xs" to="/whatsapp-demo">
            WhatsApp
          </Link>
          <Link className="btn btn-secondary text-xs" to="/pilot">
            Pilot one-pager
          </Link>
        </div>
      </div>

      <ol className="space-y-3">
        {SEGMENTS.map((seg, i) => (
          <li key={seg.clock} className="panel p-4">
            <div className="flex items-start gap-3">
              <button
                type="button"
                className="mt-0.5 text-[var(--gold)]"
                onClick={() => setDone((d) => ({ ...d, [i]: !d[i] }))}
                aria-label="Mark done"
              >
                <CheckCircle2 size={22} className={done[i] ? 'opacity-100' : 'opacity-30'} />
              </button>
              <div className="flex-1">
                <div className="flex flex-wrap items-baseline gap-2 mb-1">
                  <span className="text-xs font-mono text-[var(--sand)]">{seg.clock}</span>
                  <h2 className="font-display text-xl text-[var(--gold-soft)]">{seg.title}</h2>
                </div>
                <p className="text-sm leading-relaxed text-[var(--text)] whitespace-pre-wrap">{seg.say}</p>
              </div>
            </div>
          </li>
        ))}
      </ol>

      <div className="panel p-4 text-sm text-[var(--text-muted)]">
        <strong className="text-[var(--gold-soft)]">If live mic fails:</strong> use “Play sample call” immediately , 
        never debug audio in front of the buyer. Fallback text chat on the dashboard uses the same state machine.
      </div>
    </div>
  )
}
