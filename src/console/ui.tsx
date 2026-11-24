import type { ReactNode } from 'react'
import type { Span } from '../../server/tracingCore.ts'
import type { Tenant } from '../../server/platform/tenant.ts'
import { brand, type TurnResult } from './engine'
import { statusOf, type Call, type CallState } from './state'

export const initials = (t: Tenant) => brand(t).split(/\s+/).filter((w) => /^[A-Z]/.test(w)).slice(0, 2).map((w) => w[0]).join('')
export const fmtTime = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
export const fmtMs = (ms: number) => (ms < 1 ? ms.toFixed(2) : ms < 10 ? ms.toFixed(1) : String(Math.round(ms)))
export const callTitle = (c: Call) => (c.state.slots.name ? c.state.slots.name : `Call ${c.id.slice(0, 4)}`)
export function callSummary(c: Call): string {
  const s = c.state.slots
  if (s.roomType || s.checkIn) return [s.roomType, s.checkIn && s.checkOut ? `${s.checkIn} → ${s.checkOut}` : s.checkIn, s.guests ? `${s.guests} guests` : ''].filter(Boolean).join(' · ')
  if (s.treatment) return [s.treatment, s.location, s.date && s.time ? `${s.date} ${s.time}` : s.date].filter(Boolean).join(' · ')
  const last = c.turns.at(-1)
  return last ? last.say : 'Ringing…'
}

export function StatusChip({ c }: { c: Call }) {
  const s = statusOf(c)
  const map = { live: ['acc', 'Live'], booked: ['acc', 'Booked'], handed: ['warn', 'Handed off'], screened: ['bad', 'Screened'], answered: ['', 'Answered'] } as const
  const [cls, label] = map[s]
  return <span className={`chip ${cls}`}>{s === 'live' && <span className="dot" style={{ width: 6, height: 6, boxShadow: 'none' }} />}{label}</span>
}

export function Empty({ icon, title, body, children }: { icon: ReactNode; title: string; body: string; children?: ReactNode }) {
  return <div className="empty"><div className="ico">{icon}</div><h2>{title}</h2><p>{body}</p>{children && <div className="acts">{children}</div>}</div>
}

const label = (n: string) => n.replace(/^agent:/, '').replace(/^tool:/, '↳ ')

/** Per-agent / per-tool swimlanes for one turn, positioned by real span start and duration. */
export function Swimlane({ r, title }: { r: TurnResult; title?: string }) {
  const spans: Span[] = r.trace.spans
  if (!spans.length) return <div className="tl"><div className="tl-h">No spans recorded for this turn.</div></div>
  const t0 = Math.min(...spans.map((s) => s.start_ms))
  const end = Math.max(...spans.map((s) => s.start_ms - t0 + s.duration_ms), 0.05)
  const total = spans.filter((s) => s.name.startsWith('agent:')).reduce((a, s) => a + s.duration_ms, 0)
  return (
    <div className="tl" role="group" aria-label="Per-agent trace">
      <div className="tl-h"><span>{title ?? `Turn ${r.trace.turn_id}`}</span><span className="mono">{fmtMs(total)} ms in agents</span></div>
      {spans.map((s, i) => {
        const tool = s.name.startsWith('tool:')
        const a = s.attrs ?? {}
        const d = [a.decision && `${a.decision}`, a.rule && `rule ${a.rule}`, a.model && a.model !== 'rules' ? `model ${a.model}` : null, s.error && `error: ${s.error}`].filter(Boolean).join(' · ')
        return (
          <div key={i}>
            <div className="lane">
              <span className="ln" title={s.name}>{label(s.name)}</span>
              <div className="track"><i className={`${tool ? 'tool' : ''} ${s.ok ? '' : 'err'}`} style={{ left: `${((s.start_ms - t0) / end) * 100}%`, width: `${Math.max(0.6, (s.duration_ms / end) * 100)}%` }} /></div>
              <span className="ms">{fmtMs(s.duration_ms)}</span>
            </div>
            {d && <div className="lane-d" style={{ display: 'grid', gridTemplateColumns: '150px 1fr' }}><span /><span>{d}</span></div>}
          </div>
        )
      })}
    </div>
  )
}

/** Booking slots and checks for one call. */
export function Inspector({ c, t }: { c: Call; t: Tenant }) {
  const s = c.state.slots
  const rows: Array<[string, string | number | undefined]> = t.vertical === 'dental'
    ? [['treatment', s.treatment], ['location', s.location], ['date', s.date], ['time', s.time], ['name', s.name], ['phone', s.phone]]
    : [['check_in', s.checkIn], ['check_out', s.checkOut], ['guests', s.guests], ['room_type', s.roomType], ['name', s.name], ['phone', s.phone]]
  const rs = c.turns.map((x) => x.result).filter(Boolean) as TurnResult[]
  const last = rs.at(-1)
  const tools = [...new Set(rs.flatMap((r) => r.tools.map((x) => x.tool)))]
  return (
    <>
      <div className="th">Booking state</div>
      {rows.map(([k, v]) => <div key={k} className={`slot ${v !== undefined && v !== '' ? 'done' : ''}`}><span className="k"><i />{k}</span><span className={`v ${v === undefined ? 'e' : ''}`}>{v ?? '—'}</span></div>)}
      <div className={`slot ${c.state.booked ? 'done' : ''}`}><span className="k"><i />confirmed</span><span className={`v ${c.state.booked ? '' : 'e'}`}>{c.state.booked ? c.state.booked.ref : c.state.awaitingConfirmation ? 'awaiting “yes”' : '—'}</span></div>
      <div className="th" style={{ marginTop: 16 }}>Last handoff</div>
      <div className="chips">{last ? last.handoffs.map((h, i) => <span key={i} className="chip">{h.from} → {h.to} · {h.reason}</span>) : <span className="chip">none yet</span>}</div>
      <div className="th">Tools used</div>
      <div className="chips">{tools.length ? tools.map((x) => <span key={x} className="chip acc">{x}</span>) : <span className="chip">none</span>}</div>
      <div className="th">Checks this call</div>
      <Checks rs={rs} state={c.state} />
    </>
  )
}

function Checks({ rs, state }: { rs: TurnResult[]; state: CallState }) {
  const inj = rs.filter((r) => r.injection.length).length
  const cross = rs.filter((r) => r.guard.crossTenant.length).length
  const model = rs.filter((r) => r.tokens).length
  const tokens = rs.reduce((a, r) => a + (r.tokens ? r.tokens.prompt + r.tokens.completion : 0), 0)
  const unconfirmed = rs.filter((r, i) => r.booking && !(i > 0 && rs[i - 1].pendingConfirmation)).length
  return (
    <>
      <div className="check"><span>Injection screen</span><b className={inj ? 'bad' : ''}>{inj ? `${inj} blocked` : 'clean'}</b></div>
      <div className="check"><span>Cross-tenant leak</span><b className={cross ? 'bad' : ''}>{cross ? `${cross} blocked` : 'none'}</b></div>
      <div className="check"><span>Writes without confirm</span><b className={unconfirmed ? 'bad' : ''}>{unconfirmed}</b></div>
      <div className="check"><span>Model calls / tokens</span><b style={{ color: 'var(--t1)' }}>{model} / {tokens}</b></div>
      <div className="check"><span>Escalated</span><b style={{ color: state.escalated ? 'var(--warn)' : undefined }}>{state.escalated ? 'yes' : 'no'}</b></div>
    </>
  )
}

export function Transcript({ c, agentName }: { c: Call; agentName: string }) {
  return (
    <div>
      <div className="th">Transcript</div>
      <div className="m b"><span className="w">{agentName}</span><span>{c.greeting}</span></div>
      {c.turns.map((x) => (
        <div key={x.id}>
          <div className="m"><span className="w">Caller</span><span>{x.say}</span></div>
          {x.result && <div className="m b"><span className="w">{agentName}</span><span>{x.result.text}</span></div>}
          {x.error && <div className="m"><span className="w" style={{ color: 'var(--bad)' }}>Error</span><span>{x.error}</span></div>}
        </div>
      ))}
    </div>
  )
}
