import { CalendarRange, CreditCard, Inbox, MessageCircle, Package, Sparkles } from 'lucide-react'
import { useMemo, useState } from 'react'
import { RESORT } from '../config/resort'
import { useDemo } from '../store/DemoContext'
import type { BookingFields, Channel, StaffTicket } from '../lib/types'

/** Sandbox availability when Opera read gate is ON — never invents a sell rate. */
export function operaSandboxQuote(b: BookingFields): {
  status: 'available' | 'limited' | 'need_dates'
  category: string
  nights: number
  note: string
} {
  if (!b.checkIn || !b.checkOut) {
    return {
      status: 'need_dates',
      category: b.roomCategory || 'Deluxe / suite (TBD)',
      nights: 0,
      note: 'Collect check-in and check-out to run sandbox inventory read.',
    }
  }
  const inMs = Date.parse(b.checkIn)
  const outMs = Date.parse(b.checkOut)
  const nights =
    Number.isFinite(inMs) && Number.isFinite(outMs) && outMs > inMs
      ? Math.round((outMs - inMs) / 86400000)
      : 0
  const hash = (b.checkIn + b.checkOut + (b.roomCategory || '')).length
  const limited = hash % 5 === 0
  const category = b.roomCategory || 'Al Ubayya Deluxe (stub)'
  return {
    status: limited ? 'limited' : 'available',
    category,
    nights,
    note: limited
      ? 'Sandbox OHIP stub: limited inventory for these dates. Desk must confirm before guarantee.'
      : 'Sandbox OHIP stub: tentative availability. Rate and guarantee still confirmed by reservations — AI does not quote AED.',
  }
}

function guestConfirmBody(b: BookingFields, language: 'en' | 'ar'): string {
  if (language === 'ar') {
    return `مرحباً ${b.guestName || 'ضيفنا'}، استلمنا طلب حجزك في ${RESORT.name}. التواريخ: ${b.checkIn || '—'} → ${b.checkOut || '—'}. سيتواصل معك فريق الحجوزات لتأكيد التوفر والسعر. هذا تنبيه تجريبي فقط.`
  }
  return `Hi ${b.guestName || 'Guest'}, we received your stay inquiry at ${RESORT.name}. Dates: ${b.checkIn || '—'} → ${b.checkOut || '—'}${b.rooms ? `, ${b.rooms} room(s)` : ''}. Reservations will call back to confirm availability and rate. This is a demo guest confirmation — not a final booking.`
}

export function GuestWhatsAppConfirmPanel() {
  const demo = useDemo()
  const { session, settings } = demo
  const inquiryDone =
    session.outcome === 'booked_inquiry' || session.outcome === 'after_hours_saved'
  const [sent, setSent] = useState(false)

  if (!inquiryDone && !sent) {
    return (
      <div className="panel p-4 space-y-2">
        <h2 className="font-display text-xl text-[var(--gold-soft)] flex items-center gap-2">
          <MessageCircle size={18} /> Guest WhatsApp confirm
        </h2>
        <p className="text-xs text-[var(--text-muted)]">
          Guest confirmation message after an inquiry is captured.
        </p>
      </div>
    )
  }

  const body = guestConfirmBody(session.booking, settings.language)

  return (
    <div className="panel p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="font-display text-xl text-[var(--gold-soft)] flex items-center gap-2">
            <MessageCircle size={18} /> Guest WhatsApp confirm
          </h2>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">
            Guest-facing thread · separate from desk alert
          </p>
        </div>
        <span className="demo-badge">Guest confirm</span>
      </div>
      <div className="rounded-2xl overflow-hidden border border-[var(--border)]">
        <div className="bg-[var(--wa-green)] text-white px-3 py-2 text-xs flex justify-between">
          <span>{session.booking.guestName || 'Guest'} · mobile</span>
          <span className="opacity-80">{session.booking.phone || '+971…'}</span>
        </div>
        <div className="p-3 bg-[#ece5dd]">
          <div className="bg-[var(--wa-bubble-in)] text-[#111b21] rounded-xl rounded-tl-sm px-3 py-2 text-sm max-w-[95%] shadow-sm border border-[var(--border)]">
            {body}
            <div className="text-[10px] text-right opacity-70 mt-1">
              {new Date().toLocaleTimeString()}
            </div>
          </div>
        </div>
      </div>
      <button
        type="button"
        className="btn btn-light text-xs"
        onClick={() => {
          setSent(true)
          demo.pushAudit('ai', 'guest_wa_confirm', 'Simulated guest confirmation WhatsApp')
        }}
      >
        {sent ? 'Simulated · sent' : 'Simulate send to guest'}
      </button>
    </div>
  )
}

export function PreArrivalJourneyPanel() {
  const [active, setActive] = useState(false)
  const steps = [
    { when: 'T−7 days', title: 'Pre-arrival welcome', detail: 'Resort intro, check-in time, parking, mosque transfer tip' },
    { when: 'T−1 day', title: 'Arrival logistics', detail: 'ETA ask, late check-in note, kids club / spa soft upsell' },
    { when: 'Day of', title: 'Day-of nudge', detail: 'Lobby directions, luggage storage, dining open hours' },
    { when: 'In-stay', title: 'In-stay assist', detail: 'HK / F&B / ENG requests → tickets (already in voice path)' },
    { when: 'T+1', title: 'Post-stay ask', detail: 'Thank-you + review link (demo stub, no live send)' },
  ]

  return (
    <div className="panel p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="font-display text-xl text-[var(--gold-soft)] flex items-center gap-2">
            <CalendarRange size={18} /> Pre-arrival journey
          </h2>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">
            Automated guest touchpoints after a confirmed stay
          </p>
        </div>
        <span className="demo-badge">Journey</span>
      </div>
      <button
        type="button"
        className="btn btn-ghost text-xs"
        onClick={() => setActive((v) => !v)}
      >
        {active ? 'Hide timeline' : 'Preview journey for sample stay'}
      </button>
      {active && (
        <ol className="space-y-2">
          {steps.map((s) => (
            <li
              key={s.when}
              className="flex gap-3 text-sm border-b border-[var(--border)]/60 pb-2"
            >
              <span className="text-[10px] uppercase tracking-wide text-[var(--gold)] w-16 shrink-0 pt-0.5">
                {s.when}
              </span>
              <div>
                <div className="font-medium">{s.title}</div>
                <div className="text-xs text-[var(--text-muted)]">{s.detail}</div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

export function OperaSandboxQuotePanel() {
  const demo = useDemo()
  const { settings, session } = demo
  const quote = useMemo(() => operaSandboxQuote(session.booking), [session.booking])

  if (!settings.operaReadEnabled) {
    return (
      <div className="panel p-4 space-y-2">
        <h2 className="font-display text-xl text-[var(--gold-soft)] flex items-center gap-2">
          <Sparkles size={18} /> Sandbox availability
        </h2>
        <p className="text-sm text-[var(--text-muted)]">
          Enable <strong className="text-[var(--text)]">Opera availability read</strong> in the PMS gate.
          Still no invented AED rate.
        </p>
      </div>
    )
  }

  return (
    <div className="panel p-4 space-y-3 border-[rgba(15,118,110,0.35)]">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="font-display text-xl text-[var(--gold-soft)] flex items-center gap-2">
            <Sparkles size={18} /> Sandbox availability
          </h2>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">
            OHIP-style inventory stub · read path only
          </p>
        </div>
        <span className="demo-badge">Read ON</span>
      </div>
      {quote.status === 'need_dates' ? (
        <p className="text-sm text-[var(--text-muted)]">{quote.note}</p>
      ) : (
        <div className="rounded border border-[var(--border)] p-3 text-sm space-y-1">
          <div className="flex justify-between gap-2">
            <span className="text-[var(--text-muted)]">Status</span>
            <span
              className={
                quote.status === 'available' ? 'text-[var(--success)] font-semibold' : 'text-[var(--gold)] font-semibold'
              }
            >
              {quote.status === 'available' ? 'Tentative available' : 'Limited'}
            </span>
          </div>
          <div className="flex justify-between gap-2">
            <span className="text-[var(--text-muted)]">Category</span>
            <span>{quote.category}</span>
          </div>
          <div className="flex justify-between gap-2">
            <span className="text-[var(--text-muted)]">Nights</span>
            <span>{quote.nights || '—'}</span>
          </div>
          <p className="text-xs text-[var(--text-muted)] pt-2 border-t border-[var(--border)]">{quote.note}</p>
        </div>
      )}
    </div>
  )
}

export function MockPaymentPanel() {
  const demo = useDemo()
  const { session, settings } = demo
  const ready =
    session.outcome === 'booked_inquiry' ||
    session.outcome === 'after_hours_saved' ||
    Boolean(session.booking.guestName && session.booking.checkIn)
  const [linkShown, setLinkShown] = useState(false)

  return (
    <div className="panel p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="font-display text-xl text-[var(--gold-soft)] flex items-center gap-2">
            <CreditCard size={18} /> Guarantee link
          </h2>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">
            Mock only — no charge
          </p>
        </div>
        <span className="demo-badge">No charge</span>
      </div>
      {!ready ? (
        <p className="text-sm text-[var(--text-muted)]">Capture guest + dates first, then offer a demo guarantee link.</p>
      ) : (
        <>
          <p className="text-sm text-[var(--text-muted)]">
            Write-back is {settings.operaWriteUnlocked ? 'unlocked (demo flag)' : 'LOCKED'}. Payment stays
            mock until finance + IT approve a real PSP.
          </p>
          <button
            type="button"
            className="btn btn-light text-xs"
            onClick={() => setLinkShown(true)}
          >
            Generate demo guarantee link
          </button>
          {linkShown && (
            <div className="rounded border border-[var(--border)] px-3 py-2 text-xs font-mono break-all bg-white">
              https://pay.demo.erth.local/guarantee/{session.id.slice(0, 8)}?amt=HOLD
            </div>
          )}
        </>
      )}
    </div>
  )
}

type InboxItem = {
  id: string
  at: number
  channel: Channel | 'desk'
  title: string
  preview: string
  tone: 'normal' | 'high'
}

export function UnifiedInboxPanel() {
  const demo = useDemo()
  const { tickets, notifications, sessions } = demo

  const items = useMemo(() => {
    const list: InboxItem[] = []
    for (const t of tickets.slice(0, 8)) {
      list.push({
        id: `t-${t.id}`,
        at: t.timestamp,
        channel: t.channel,
        title: t.reason,
        preview: `${t.guestName} · ${t.summary}`,
        tone: t.priority === 'high' ? 'high' : 'normal',
      })
    }
    for (const n of notifications.slice(0, 5)) {
      list.push({
        id: `n-${n.id}`,
        at: n.timestamp,
        channel: 'desk',
        title: n.subject,
        preview: n.body.slice(0, 100),
        tone: 'normal',
      })
    }
    for (const s of sessions || []) {
      if (s.status === 'in_call' || s.status === 'ringing') {
        list.push({
          id: `s-${s.id}`,
          at: s.startedAt || Date.now(),
          channel: s.channel,
          title: `Live line ${s.line}`,
          preview: s.booking.guestName || 'Guest on line',
          tone: 'high',
        })
      }
    }
    return list.sort((a, b) => b.at - a.at).slice(0, 10)
  }, [tickets, notifications, sessions])

  return (
    <div className="panel p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="font-display text-xl text-[var(--gold-soft)] flex items-center gap-2">
            <Inbox size={18} /> Unified inbox
          </h2>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">
            Voice + WhatsApp + desk alerts in one place
          </p>
        </div>
        <span className="demo-badge">Omni</span>
      </div>
      {items.length === 0 ? (
        <p className="text-sm text-[var(--text-muted)]">Run a missed-call or guest chat — items land here.</p>
      ) : (
        <ul className="space-y-2 max-h-56 overflow-y-auto">
          {items.map((it) => (
            <li
              key={it.id}
              className="flex gap-2 text-sm border-b border-[var(--border)]/50 pb-2"
            >
              <span
                className={`text-[10px] uppercase tracking-wide shrink-0 w-14 pt-0.5 ${
                  it.tone === 'high' ? 'text-[var(--danger)]' : 'text-[var(--text-muted)]'
                }`}
              >
                {it.channel}
              </span>
              <div className="min-w-0">
                <div className="font-medium truncate">{it.title}</div>
                <div className="text-xs text-[var(--text-muted)] truncate">{it.preview}</div>
              </div>
              <span className="text-[10px] text-[var(--text-muted)] ml-auto shrink-0">
                {new Date(it.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Warm handoff packet — what staff see when claiming. */
export function WarmHandoffPanel({ ticket }: { ticket: StaffTicket | null }) {
  const demo = useDemo()
  const { session } = demo
  const b = session.booking
  const active = ticket || (session.outcome === 'transferred' ? {
    id: 'live',
    reason: 'Live handoff',
    summary: 'Guest requested human / AI escalated',
    guestName: b.guestName || 'Guest',
    phone: b.phone || '-',
    timestamp: Date.now(),
    status: 'open' as const,
    priority: 'high' as const,
    channel: session.channel,
  } : null)

  if (!active && session.transcript.length < 2) {
    return (
      <div className="panel p-4 space-y-2">
        <h2 className="font-display text-xl text-[var(--gold-soft)] flex items-center gap-2">
          <Package size={18} /> Warm handoff packet
        </h2>
        <p className="text-xs text-[var(--text-muted)]">
          Opens when a ticket exists or guest asks for a human — full context for the desk.
        </p>
      </div>
    )
  }

  const lastGuest = [...session.transcript].reverse().find((t) => t.speaker === 'Guest')
  const sentiment = /angry|furious|unacceptable|complaint|broken|leak|ac\b/i.test(
    `${active?.summary || ''} ${lastGuest?.text || ''}`,
  )
    ? 'Frustrated / priority'
    : 'Calm / routine'

  return (
    <div className="panel p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="font-display text-xl text-[var(--gold-soft)] flex items-center gap-2">
            <Package size={18} /> Warm handoff packet
          </h2>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">
            Staff sees this on claim — full context packet
          </p>
        </div>
        <span className="demo-badge">Handoff</span>
      </div>
      <dl className="grid grid-cols-2 gap-2 text-sm">
        <div>
          <dt className="text-[10px] uppercase text-[var(--text-muted)]">Guest</dt>
          <dd>{active?.guestName || b.guestName || '—'}</dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase text-[var(--text-muted)]">Phone</dt>
          <dd>{active?.phone || b.phone || '—'}</dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase text-[var(--text-muted)]">Intent / reason</dt>
          <dd>{active?.reason || session.intent || '—'}</dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase text-[var(--text-muted)]">Sentiment</dt>
          <dd className={sentiment.startsWith('Frustrated') ? 'text-[var(--danger)]' : ''}>
            {sentiment}
          </dd>
        </div>
        <div className="col-span-2">
          <dt className="text-[10px] uppercase text-[var(--text-muted)]">Dates / party</dt>
          <dd>
            {b.checkIn || '—'} → {b.checkOut || '—'} · {b.adults ?? '—'} adults / {b.children ?? 0}{' '}
            children · {b.rooms ?? 1} room
          </dd>
        </div>
        <div className="col-span-2">
          <dt className="text-[10px] uppercase text-[var(--text-muted)]">Last guest line</dt>
          <dd className="text-[var(--text-muted)]">{lastGuest?.text || active?.summary || '—'}</dd>
        </div>
        <div className="col-span-2">
          <dt className="text-[10px] uppercase text-[var(--text-muted)]">Suggested next action</dt>
          <dd>
            {active?.priority === 'high'
              ? 'Call guest now · confirm Opera inventory · close ticket when done'
              : 'Callback within SLA · confirm rate · update guest on WhatsApp'}
          </dd>
        </div>
      </dl>
    </div>
  )
}

/** Bundle used on dashboard under IT pack */
export function CompetitorParitySection() {
  const demo = useDemo()
  const latestTicket = demo.tickets[0] ?? null

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="font-display text-2xl text-[var(--gold-soft)]">Hospitality feature pack</h2>
          <p className="text-xs text-[var(--text-muted)]">
            Capabilities included in this sandbox
          </p>
        </div>
        <span className="demo-badge">Sandbox</span>
      </div>
      <div className="grid lg:grid-cols-2 gap-4">
        <UnifiedInboxPanel />
        <WarmHandoffPanel ticket={latestTicket} />
        <OperaSandboxQuotePanel />
        <GuestWhatsAppConfirmPanel />
        <PreArrivalJourneyPanel />
        <MockPaymentPanel />
      </div>
    </div>
  )
}
