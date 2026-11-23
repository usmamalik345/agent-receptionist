import { RESORT } from '../config/resort'
import { useBusiness } from '../store/BusinessContext'

export function PilotPage() {
  const { biz, preset } = useBusiness()
  const seller = biz.hotelExtras?.seller || {
    name: 'Usama Malik',
    role: 'Independent AI Engineer',
    market: biz.industry === 'dental' ? 'UK dental practices' : RESORT.seller.market,
  }
  const isDental = biz.industry === 'dental'
  const customer = preset.wording.customerNoun
  const booking = preset.wording.bookingNoun

  return (
    <div className="max-w-3xl mx-auto space-y-6 print:space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <span className="demo-badge mb-2">READY TO START · {biz.name.toUpperCase()}</span>
          <h1 className="font-display text-4xl text-[var(--gold-soft)] leading-tight mt-2">
            Overflow go-live — product ready now
          </h1>
          <p className="text-[var(--text-muted)] mt-1">
            {isDental ? 'UK dental practices' : 'Gulf hospitality reservations'} · Prepared by {seller.name}
          </p>
        </div>
        <button className="btn btn-light no-print" onClick={() => window.print()}>
          Print / PDF
        </button>
      </div>

      <section className="panel p-5 space-y-3">
        <h2 className="font-display text-2xl text-[var(--gold-soft)]">Company profile</h2>
        <p className="text-sm leading-relaxed">
          <strong className="text-[var(--gold-soft)]">{seller.name}</strong> — {seller.role} focused on{' '}
          {seller.market}. AI voice + WhatsApp receptionists that answer after-hours and overflow, capture
          structured {booking} requests, notify the team, and always offer human takeover.
        </p>
        <div className="grid sm:grid-cols-2 gap-3 text-sm">
          <div className="rounded-lg border border-[var(--border)] p-3">
            <div className="text-xs uppercase text-[var(--text-muted)] mb-1">What I deliver</div>
            <ul className="list-disc pl-5 space-y-1 text-[var(--text-muted)]">
              <li>Voice + WhatsApp {customer} conversation</li>
              <li>Ops dashboard: fields, transcript, notify, Claim/Done queue</li>
              <li>Pilot-first: overflow telephony → team delivery before live writes</li>
            </ul>
          </div>
          <div className="rounded-lg border border-[var(--border)] p-3">
            <div className="text-xs uppercase text-[var(--text-muted)] mb-1">This demo</div>
            <p className="text-[var(--text-muted)] leading-relaxed">
              {biz.name} sandbox ({biz.demoBadge || 'DEMO'}), working reference for stakeholder review.
            </p>
          </div>
        </div>
        <p className="text-xs text-[var(--text-muted)]">Contact: {seller.name} · usmamalik344@gmail.com</p>
      </section>

      <section className="panel p-5 space-y-2">
        <h2 className="font-display text-2xl text-[var(--gold-soft)]">Problem</h2>
        <p className="text-sm leading-relaxed text-[var(--text)]">
          {isDental
            ? 'Practice phone lines miss calls outside staffing hours. Emergencies and new-patient enquiries go unanswered. Callers who cannot leave a structured message rarely call back with the same intent.'
            : 'Reservation phone lines miss calls outside peak staffing. After-hours and overflow periods lose stays that never become booked inquiries.'}
        </p>
      </section>

      <section className="panel p-5 space-y-2">
        <h2 className="font-display text-2xl text-[var(--gold-soft)]">Solution</h2>
        <p className="text-sm leading-relaxed">
          An AI voice + WhatsApp receptionist that answers after-hours and overflow, collects {booking} intent,
          notifies the {preset.wording.deskNoun} instantly, and always offers human takeover. Requests are sent to
          the team — never invented live diary slots or prices outside config.
        </p>
      </section>

      <section className="panel p-5 space-y-2">
        <h2 className="font-display text-2xl text-[var(--gold-soft)]">Security notes for IT</h2>
        <ul className="text-sm space-y-2">
          <li>
            <strong className="text-[var(--gold-soft)]">Demo is sandbox.</strong> Sample data only.
          </li>
          <li>
            <strong className="text-[var(--gold-soft)]">Human takeover</strong> is always available via toggle,
            “agent please”, or Claim from the queue.
          </li>
        </ul>
      </section>

      <p className="text-xs text-center text-[var(--text-muted)] pb-6">
        {biz.name} branding in this pack is a demo stand-in, not an official product endorsement.
      </p>
    </div>
  )
}
