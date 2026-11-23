import { useMemo, useState } from 'react'

/**
 * Meeting differentiator: cost / coverage story vs generic chatbots.
 * Numbers are ILLUSTRATIVE (DEMO) — Hany can replace with Erth traffic later.
 */
export function CostDifferencePanel() {
  const [missedPerWeek, setMissedPerWeek] = useState(12)
  const [aedPerStay, setAedPerStay] = useState(900)
  const [nightHours, setNightHours] = useState(10)

  const weeklyAtRisk = useMemo(() => missedPerWeek * aedPerStay, [missedPerWeek, aedPerStay])
  const monthlyAtRisk = weeklyAtRisk * 4
  const nightStaffHoursMonth = nightHours * 30

  return (
    <div className="p-4 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-xs text-[var(--text-muted)] max-w-2xl">
            Not “replace your team.” Cover thin hours — recover inquiries that never reach Opera. Numbers are{' '}
            <span className="demo-badge ml-1">DEMO · illustrative</span>
          </p>
        </div>
      </div>

      <div className="grid sm:grid-cols-3 gap-3 text-sm">
        <div className="rounded-lg border border-[var(--border)] p-3">
          <div className="text-[10px] uppercase text-[var(--text-muted)] mb-1">Missed calls / week</div>
          <input
            type="number"
            min={1}
            max={80}
            className="w-full bg-[var(--bg)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--gold-soft)] font-semibold"
            value={missedPerWeek}
            onChange={(e) => setMissedPerWeek(Number(e.target.value) || 0)}
          />
        </div>
        <div className="rounded-lg border border-[var(--border)] p-3">
          <div className="text-[10px] uppercase text-[var(--text-muted)] mb-1">AED per recovered stay</div>
          <input
            type="number"
            min={100}
            step={50}
            className="w-full bg-[var(--bg)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--gold-soft)] font-semibold"
            value={aedPerStay}
            onChange={(e) => setAedPerStay(Number(e.target.value) || 0)}
          />
        </div>
        <div className="rounded-lg border border-[var(--border)] p-3">
          <div className="text-[10px] uppercase text-[var(--text-muted)] mb-1">Night hours AI covers</div>
          <input
            type="number"
            min={4}
            max={14}
            className="w-full bg-[var(--bg)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--gold-soft)] font-semibold"
            value={nightHours}
            onChange={(e) => setNightHours(Number(e.target.value) || 0)}
          />
        </div>
      </div>

      <div className="grid sm:grid-cols-3 gap-3">
        <Stat
          label="Weekly revenue at risk (illustrative)"
          value={`AED ${weeklyAtRisk.toLocaleString()}`}
        />
        <Stat
          label="Monthly at risk if unanswered"
          value={`AED ${monthlyAtRisk.toLocaleString()}`}
        />
        <Stat
          label="Night desk hours / month covered"
          value={`${nightStaffHoursMonth} hrs`}
        />
      </div>

      <div className="grid md:grid-cols-2 gap-3 text-xs">
        <div className="rounded-lg border border-[var(--border)] p-3 space-y-1.5">
          <div className="font-semibold text-[var(--gold-soft)]">What generic SaaS / chatbots often miss</div>
          <ul className="list-disc pl-4 text-[var(--text-muted)] space-y-1">
            <li>Website chat only — not the ringing reservations phone</li>
            <li>No structured booking fields for Opera callback</li>
            <li>No desk WhatsApp / Claim queue when night staff is thin</li>
            <li>Fake “booked” without IT-safe handoff</li>
          </ul>
        </div>
        <div className="rounded-lg border border-[var(--gold)]/40 p-3 space-y-1.5">
          <div className="font-semibold text-[var(--gold-soft)]">This agent (advanced for hospitality)</div>
          <ul className="list-disc pl-4 text-[var(--text-muted)] space-y-1">
            <li>
              <strong className="text-[var(--text)]">Voice overflow + WhatsApp</strong> — one booking brain
            </li>
            <li>
              <strong className="text-[var(--text)]">EN + Arabic</strong> without hiring night bilingual desk
            </li>
            <li>
              <strong className="text-[var(--text)]">FAQ deflection</strong> — airport, spa, hours without staff
            </li>
            <li>
              <strong className="text-[var(--text)]">Desk WhatsApp + Claim/Done</strong> — staff only on value work
            </li>
            <li>
              <strong className="text-[var(--text)]">IT-safe</strong> — no Opera write until you approve
            </li>
          </ul>
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg)] p-3">
      <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{label}</div>
      <div className="font-display text-2xl text-[var(--gold-soft)] mt-1">{value}</div>
    </div>
  )
}
