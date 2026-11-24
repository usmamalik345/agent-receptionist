import { CalendarCheck, Inbox, Play } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { speakText, waitForVoices } from '../lib/speech'
import { pickBestVoice } from '../lib/voicePick'
import { brand, platform, tenantList, tenants } from './engine'
import { useConsole } from './state'
import { fmtTime, TraceTimeline } from './ui'

const DAYS = [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun']] as const

function Empty({ icon, title, body, action }: { icon: React.ReactNode; title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="cx-empty">
      <div style={{ color: 'var(--text-3)', marginBottom: 12 }}>{icon}</div>
      <h2 style={{ fontSize: 17 }}>{title}</h2>
      <p>{body}</p>
      {action}
    </div>
  )
}

export function InboxView({ tenantId }: { tenantId: string }) {
  const { calls } = useConsole()
  const { callId } = useParams()
  const mine = calls.filter((c) => c.tenantId === tenantId && c.messages.length > 1)
  const call = mine.find((c) => c.id === callId) ?? null
  return (
    <>
      <div className="cx-top"><h1>Conversations</h1><span className="cx-badge">{mine.length}</span></div>
      {!mine.length ? (
        <Empty icon={<Inbox size={28} />} title="No conversations yet" body="Calls made from Test call appear here with their transcript and per-agent trace." action={<Link className="cx-btn" to={`/app/${tenantId}/chat`}>Start a test call</Link>} />
      ) : (
        <div className="cx-split" data-detail={String(Boolean(call))} style={{ height: 'calc(100% - 52px)' }}>
          <nav className="cx-list" aria-label="Conversations">
            {mine.map((c) => {
              const last = c.messages[c.messages.length - 1]
              return (
                <Link key={c.id} to={`/app/${tenantId}/inbox/${c.id}`} aria-current={c.id === callId ? 'page' : undefined}>
                  <div className="l1"><span>Call {c.id.slice(0, 6)}</span><time>{fmtTime(c.startedAt)}</time></div>
                  <div className="l2">{last.text}</div>
                  <div style={{ marginTop: 6 }}>
                    <span className={`cx-badge ${c.status === 'booked' ? 'ok' : c.status === 'escalated' ? 'warn' : ''}`}>{c.status === 'booked' ? 'Booked' : c.status === 'escalated' ? 'Handed to team' : 'Active'}</span>
                  </div>
                </Link>
              )
            })}
          </nav>
          <section className="cx-detail" aria-label="Conversation detail">
            {!call ? <Empty icon={<Inbox size={28} />} title="Select a conversation" body="Pick a call on the left to see the transcript and trace." /> : (
              <div className="cx-card">
                <h3>Transcript</h3>
                <p className="desc">{call.messages.length} messages · started {fmtTime(call.startedAt)}</p>
                {call.messages.map((m) => (
                  <div className="cx-turn" key={m.id}>
                    <div className="cx-who">{m.role === 'user' ? 'Caller' : `${tenants.get(call.tenantId)!.voice.agentName}${m.result ? ` · ${m.result.agent} agent · ${m.result.intent}` : ''}`}</div>
                    <div>{m.text}</div>
                    {m.result && <TraceTimeline spans={m.result.trace.spans} />}
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}
    </>
  )
}

export function BookingsView({ tenantId }: { tenantId: string }) {
  const { bookingsVersion } = useConsole()
  const rows = useMemo(() => platform.bookings(tenantId), [tenantId, bookingsVersion]) // eslint-disable-line react-hooks/exhaustive-deps
  const t = tenants.get(tenantId)!
  return (
    <>
      <div className="cx-top"><h1>Bookings</h1><span className="cx-badge">{rows.length}</span></div>
      <div className="cx-page">
        {!rows.length ? (
          <Empty icon={<CalendarCheck size={28} />} title="No bookings yet" body={`Bookings are written only after the caller confirms. Try "${t.vertical === 'hotel' ? 'I want to book a room' : 'I need a check-up'}" in Test call.`} action={<Link className="cx-btn" to={`/app/${tenantId}/chat`}>Open Test call</Link>} />
        ) : (
          <div className="cx-card" style={{ padding: 0 }}>
            <table className="cx-table">
              <thead><tr><th>Ref</th><th>Name</th><th>{t.vertical === 'hotel' ? 'Stay' : 'Appointment'}</th><th>Details</th><th>Created</th></tr></thead>
              <tbody>
                {rows.map((b) => (
                  <tr key={b.ref}>
                    <td className="cx-mono">{b.ref}</td>
                    <td>{b.name}<div style={{ color: 'var(--text-3)', fontSize: 12 }}>{b.phone}</div></td>
                    <td>{b.kind === 'room' ? `${b.checkIn} → ${b.checkOut}` : `${b.date} ${b.time}`}</td>
                    <td>{b.kind === 'room' ? `${b.roomType} · ${b.guests} guests` : `${b.treatment} · ${b.location}`}</td>
                    <td>{fmtTime(Date.parse(b.createdAt))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}

export function SettingsView({ tenantId }: { tenantId: string }) {
  const t = tenants.get(tenantId)!
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
  const [loaded, setLoaded] = useState(false)
  const [voiceName, setVoiceName] = useState('')
  const [rate, setRate] = useState(t.voice.rate)
  const [pitch, setPitch] = useState(t.voice.pitch)
  useEffect(() => { setRate(t.voice.rate); setPitch(t.voice.pitch); setVoiceName('') }, [t])
  useEffect(() => { void waitForVoices(1500).then((v) => { setVoices(v.filter((x) => x.lang.toLowerCase().startsWith('en'))); setLoaded(true) }) }, [])
  const auto = pickBestVoice(voices, t.voice.locale, t.voice.preferredVoices)
  const preview = () => void speakText(`Hi, you're through to ${brand(t)}, this is ${t.voice.agentName}. How can I help?`, 'en', { voiceLocale: t.voice.locale, preferredVoices: voiceName ? [voiceName] : t.voice.preferredVoices, rate, pitch })
  return (
    <>
      <div className="cx-top"><h1>Settings</h1><span className="cx-badge">{brand(t)}</span></div>
      <div className="cx-page">
        <div className="cx-card">
          <h3>Voice persona</h3>
          <p className="desc">Free voices only: the browser picks the most natural installed voice (Edge “Natural”, then Google, then Premium). Changes here are a local preview; the live persona is the tenant file.</p>
          <div className="cx-field"><span className="k">Agent name</span><span>{t.voice.agentName}</span></div>
          <div className="cx-field">
            <label htmlFor="cx-voice">Voice</label>
            <select id="cx-voice" value={voiceName} onChange={(e) => setVoiceName(e.target.value)}>
              <option value="">Automatic{auto ? ` (${auto.name})` : voices.length ? '' : loaded ? ' (no voices installed in this browser)' : ' (loading voices…)'}</option>
              {voices.map((v) => <option key={v.name} value={v.name}>{v.name}</option>)}
            </select>
          </div>
          <div className="cx-field"><label htmlFor="cx-rate">Rate {rate.toFixed(2)}</label><input id="cx-rate" type="range" min={0.8} max={1.2} step={0.02} value={rate} onChange={(e) => setRate(Number(e.target.value))} /></div>
          <div className="cx-field"><label htmlFor="cx-pitch">Pitch {pitch.toFixed(2)}</label><input id="cx-pitch" type="range" min={0.8} max={1.2} step={0.02} value={pitch} onChange={(e) => setPitch(Number(e.target.value))} /></div>
          <div style={{ marginTop: 16 }}><button className="cx-btn" type="button" onClick={preview}><Play size={15} /> Preview voice</button></div>
        </div>
        <div className="cx-grid2">
          <div className="cx-card">
            <h3>Business</h3>
            <p className="desc">Loaded from <span className="cx-mono">config/tenants/{t.id}.json</span></p>
            <div className="cx-field"><span className="k">Vertical</span><span style={{ textTransform: 'capitalize' }}>{t.vertical}</span></div>
            <div className="cx-field"><span className="k">Timezone</span><span>{t.timezone}</span></div>
            <div className="cx-field"><span className="k">Policy version</span><span className="cx-mono">{t.policyVersion}</span></div>
            <div className="cx-field"><span className="k">Rate limit</span><span>{t.rateLimitPerMinute ?? 120} requests / min</span></div>
            {t.hotel && <div className="cx-field"><span className="k">Check-in / out</span><span>{t.hotel.checkInTime} / {t.hotel.checkOutTime}</span></div>}
          </div>
          <div className="cx-card">
            <h3>{t.hotel ? 'Rooms' : 'Treatments'}</h3>
            <p className="desc">Prices the agents may quote. Nothing outside this list is ever stated.</p>
            <table className="cx-table"><tbody>
              {t.hotel ? t.hotel.rooms.map((r) => <tr key={r.type}><td>{r.type}</td><td>{r.maxGuests} guests</td><td style={{ textAlign: 'right' }}>{t.currency === 'USD' ? '$' : '£'}{r.ratePerNight}/night</td></tr>)
                : t.dental!.treatments.map((r) => <tr key={r.name}><td>{r.name}</td><td>{r.durationMin} min</td><td style={{ textAlign: 'right' }}>{r.price === null ? 'After assessment' : `£${r.price}`}</td></tr>)}
            </tbody></table>
          </div>
        </div>
        {t.locations.map((l) => (
          <div className="cx-card" key={l.name}>
            <h3>{l.name}</h3>
            <p className="desc">{l.address} · {l.phone}</p>
            <table className="cx-table"><tbody><tr>{DAYS.map(([k, d]) => <td key={k}><div style={{ color: 'var(--text-3)', fontSize: 12 }}>{d}</div>{l.hours[k]}</td>)}</tr></tbody></table>
          </div>
        ))}
      </div>
    </>
  )
}

export const firstTenantId = tenantList[0]?.id
