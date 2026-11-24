import { CalendarCheck, Inbox, Play, Radio } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { speakText, waitForVoices } from '../lib/speech'
import { pickBestVoice } from '../lib/voicePick'
import { brand, platform, tenantList, tenants } from './engine'
import { scenariosFor } from './scenarios'
import { statusOf, useConsole, type Call } from './state'
import { callSummary, callTitle, Empty, fmtMs, fmtTime, Inspector, StatusChip, Swimlane, Transcript } from './ui'

const other = (id: string) => brand(tenantList.find((t) => t.id !== id && t.vertical === 'hotel') ?? tenantList[0])

function useTenantCalls(tenantId: string) {
  const { calls } = useConsole()
  return calls.filter((c) => c.tenantId === tenantId)
}

function CallRow({ c, to, current }: { c: Call; to: string; current: boolean }) {
  const last = c.turns.at(-1)
  return (
    <Link className="row" to={to} aria-current={current}>
      <div className="r1">{statusOf(c) === 'live' && <span className="dot" />}<b style={{ fontWeight: 500 }}>{callTitle(c)}</b><span className="mono">{fmtTime(c.startedAt)}</span></div>
      <div className="r2">{callSummary(c)}</div>
      <div className="r3"><StatusChip c={c} />{last?.result && <span className="chip">{last.result.agent}</span>}<span className="chip">{c.turns.length} turn{c.turns.length === 1 ? "" : "s"}</span>{c.label && <span className="chip">{c.label}</span>}</div>
    </Link>
  )
}

export function useSampleRun(tenantId: string) {
  const { runScript } = useConsole()
  const [running, setRunning] = useState(false)
  const run = async () => {
    if (running) return
    setRunning(true)
    const t = tenants.get(tenantId)!
    const sc = scenariosFor(t, other(tenantId)).filter((s) => ['booking', 'facts', 'inject', 'human'].includes(s.id))
    await Promise.all(sc.map((s, i) => runScript(tenantId, s.lines, s.title, 300 + i * 70)))
    setRunning(false)
  }
  return { run, running }
}

function Kpis({ calls }: { calls: Call[] }) {
  const turns = calls.flatMap((c) => c.turns).filter((x) => x.ms !== undefined)
  const ms = turns.map((x) => x.ms!).sort((a, b) => a - b)
  const p95 = ms.length ? ms[Math.min(ms.length - 1, Math.ceil(0.95 * ms.length) - 1)] : null
  const k: Array<[string, string]> = [
    ['Calls this session', String(calls.length)],
    ['Live now', String(calls.filter((c) => statusOf(c) === 'live').length)],
    ['Booked', String(calls.filter((c) => statusOf(c) === 'booked').length)],
    ['Handed off / screened', `${calls.filter((c) => statusOf(c) === 'handed').length} / ${calls.filter((c) => statusOf(c) === 'screened').length}`],
    ['Turn p95 (in browser)', p95 === null ? '—' : `${fmtMs(p95)} ms`],
  ]
  return <div className="kpis">{k.map(([l, v]) => <div className="kpi" key={l}><b>{v}</b><span>{l}</span></div>)}</div>
}

export function LiveView({ tenantId }: { tenantId: string }) {
  const calls = useTenantCalls(tenantId)
  const { callId } = useParams()
  const t = tenants.get(tenantId)!
  const { run, running } = useSampleRun(tenantId)
  const sel = calls.find((c) => c.id === callId) ?? calls.find((c) => statusOf(c) === 'live') ?? calls[0]
  const last = sel?.turns.filter((x) => x.result).at(-1)
  return (
    <>
      <Kpis calls={calls} />
      {!calls.length ? (
        <Empty icon={<Radio size={20} />} title="No calls yet" body={`Run a few scripted sample calls into ${brand(t)} at once, or place your own test call. Everything runs in this browser on the real agents with a mock responder.`}>
          <button className="btn pri" onClick={run} disabled={running}><Play size={14} /> Run sample calls <kbd>R</kbd></button>
          <Link className="btn" to={`/app/${tenantId}/test`}>Test call <kbd>T</kbd></Link>
        </Empty>
      ) : (
        <div className="split" data-detail={String(Boolean(callId))}>
          <nav className="list" aria-label="Calls">
            <div className="lh"><span>Calls</span><button className="btn" onClick={run} disabled={running} style={{ height: 22 }}>{running ? 'Running…' : 'Run sample calls'}</button></div>
            <div className="rows">{calls.map((c) => <CallRow key={c.id} c={c} to={`/app/${tenantId}/live/${c.id}`} current={c.id === sel?.id} />)}</div>
            <div className="kh"><kbd>J</kbd><kbd>K</kbd> move · <kbd>T</kbd> test call · <kbd>?</kbd> shortcuts</div>
          </nav>
          {sel && (
            <section className="detail" aria-label="Call detail">
              <div className="hh">
                <div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><h2>{callTitle(sel)}</h2><StatusChip c={sel} /><span className="chip">{t.voice.agentName} · {t.voice.locale}</span></div>
                  <div className="meta">Started {fmtTime(sel.startedAt)} · {sel.turns.length} turns · {sel.turns.filter((x) => x.result?.tokens).length} model calls{sel.label ? ` · scenario “${sel.label}”` : ''}</div>
                </div>
                <Link className="btn" to={`/app/${tenantId}/inbox/${sel.id}`}>Full trace</Link>
              </div>
              {last?.result ? <Swimlane r={last.result} title={`Last turn · “${last.say}”`} /> : <div className="tl"><div className="skel" style={{ width: '60%' }} /></div>}
              <div className="two"><Transcript c={sel} agentName={t.voice.agentName} /><div className="insp"><Inspector c={sel} t={t} /></div></div>
            </section>
          )}
        </div>
      )}
    </>
  )
}

export function InboxView({ tenantId }: { tenantId: string }) {
  const calls = useTenantCalls(tenantId).filter((c) => c.turns.length)
  const { callId } = useParams()
  const t = tenants.get(tenantId)!
  const sel = calls.find((c) => c.id === callId)
  if (!calls.length) return <Empty icon={<Inbox size={20} />} title="Inbox is empty" body="Finished and live calls appear here with every turn's per-agent trace."><Link className="btn pri" to={`/app/${tenantId}/test`}>Place a test call</Link></Empty>
  return (
    <div className="split" data-detail={String(Boolean(sel))}>
      <nav className="list" aria-label="Conversations">
        <div className="lh"><span>{calls.length} conversations</span><span>newest first</span></div>
        <div className="rows">{calls.map((c) => <CallRow key={c.id} c={c} to={`/app/${tenantId}/inbox/${c.id}`} current={c.id === sel?.id} />)}</div>
        <div className="kh"><kbd>J</kbd><kbd>K</kbd> move · <kbd>Esc</kbd> back</div>
      </nav>
      <section className="detail" aria-label="Conversation detail">
        {!sel ? <Empty icon={<Inbox size={20} />} title="Select a conversation" body="Pick a call to see the transcript with a trace under every turn." /> : (
          <>
            <div className="hh"><div><div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><h2>{callTitle(sel)}</h2><StatusChip c={sel} /></div><div className="meta">{fmtTime(sel.startedAt)} · {sel.turns.length} turns · call <span className="mono">{sel.id.slice(0, 8)}</span></div></div></div>
            <div className="two">
              <div>
                <div className="th">Turns</div>
                <div className="m b"><span className="w">{t.voice.agentName}</span><span>{sel.greeting}</span></div>
                {sel.turns.map((x, i) => (
                  <div key={x.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
                    <div className="m" style={{ border: 0 }}><span className="w">Caller</span><span>{x.say}</span></div>
                    {x.result && <div className="m b" style={{ border: 0 }}><span className="w">{t.voice.agentName}</span><span>{x.result.text}</span></div>}
                    {x.result && <Swimlane r={x.result} title={`Turn ${i + 1} · ${x.result.intent} → ${x.result.agent}`} />}
                  </div>
                ))}
              </div>
              <div className="insp"><Inspector c={sel} t={t} /></div>
            </div>
          </>
        )}
      </section>
    </div>
  )
}

export function BookingsView({ tenantId }: { tenantId: string }) {
  const { version } = useConsole()
  const rows = useMemo(() => platform.bookings(tenantId), [tenantId, version]) // eslint-disable-line react-hooks/exhaustive-deps
  const t = tenants.get(tenantId)!
  const nav = useNavigate()
  if (!rows.length) return <Empty icon={<CalendarCheck size={20} />} title="No bookings yet" body="A booking is written only after the caller hears the read-back and says yes."><button className="btn pri" onClick={() => nav(`/app/${tenantId}/test`)}>Run the booking scenario</button></Empty>
  return (
    <div className="sb-scroll">
      <table className="tbl">
        <thead><tr><th>Ref</th><th>Guest / patient</th><th>{t.vertical === 'hotel' ? 'Stay' : 'Appointment'}</th><th>Details</th><th>Value</th><th>Created</th></tr></thead>
        <tbody>
          {rows.map((b) => (
            <tr key={b.ref}>
              <td className="mono">{b.ref}</td>
              <td>{b.name}<div style={{ color: 'var(--t3)', fontSize: 12 }}>{b.phone}</div></td>
              <td className="mono">{b.kind === 'room' ? `${b.checkIn} → ${b.checkOut}` : `${b.date} ${b.time}`}</td>
              <td>{b.kind === 'room' ? `${b.roomType} · ${b.guests} guests` : `${b.treatment} · ${b.location}`}</td>
              <td className="mono">{b.totalPrice != null ? `${t.currency === 'USD' ? '$' : '£'}${b.totalPrice}` : '—'}</td>
              <td className="mono">{fmtTime(Date.parse(b.createdAt))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const DAYS = [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun']] as const

export function SettingsView({ tenantId }: { tenantId: string }) {
  const t = tenants.get(tenantId)!
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
  const [loaded, setLoaded] = useState(false)
  const [voiceName, setVoiceName] = useState('')
  const [rate, setRate] = useState(t.voice.rate)
  const [pitch, setPitch] = useState(t.voice.pitch)
  const [prev, setPrev] = useState(tenantId)
  if (prev !== tenantId) { setPrev(tenantId); setRate(t.voice.rate); setPitch(t.voice.pitch); setVoiceName('') }
  useEffect(() => { void waitForVoices(1500).then((v) => { setVoices(v.filter((x) => x.lang.toLowerCase().startsWith('en'))); setLoaded(true) }) }, [])
  const auto = pickBestVoice(voices, t.voice.locale, t.voice.preferredVoices)
  const preview = () => void speakText(`Hi, you're through to ${brand(t)}, this is ${t.voice.agentName}. How can I help?`, 'en', { voiceLocale: t.voice.locale, preferredVoices: voiceName ? [voiceName] : t.voice.preferredVoices, rate, pitch })
  const cur = t.currency === 'USD' ? '$' : '£'
  return (
    <div className="sb-scroll"><div className="page">
      <section className="sec">
        <header><div><h3>Voice persona</h3><p>Free voices only. Automatic picks the most natural installed voice (Edge “Natural”, then Google, then Premium). Changes here are a local preview; the live persona is the tenant file.</p></div><button className="btn" onClick={preview}><Play size={14} /> Preview</button></header>
        <div className="bd">
          <div className="fld"><span className="k">Agent name</span><span>{t.voice.agentName}</span></div>
          <div className="fld"><label htmlFor="sb-voice">Voice</label>
            <select id="sb-voice" value={voiceName} onChange={(e) => setVoiceName(e.target.value)}>
              <option value="">Automatic{auto ? ` (${auto.name})` : voices.length ? '' : loaded ? ' (no voices installed in this browser)' : ' (loading voices…)'}</option>
              {voices.map((v) => <option key={v.name} value={v.name}>{v.name}</option>)}
            </select></div>
          <div className="fld"><label htmlFor="sb-rate">Rate <span className="mono">{rate.toFixed(2)}</span></label><input id="sb-rate" type="range" min={0.8} max={1.2} step={0.02} value={rate} onChange={(e) => setRate(Number(e.target.value))} /></div>
          <div className="fld"><label htmlFor="sb-pitch">Pitch <span className="mono">{pitch.toFixed(2)}</span></label><input id="sb-pitch" type="range" min={0.8} max={1.2} step={0.02} value={pitch} onChange={(e) => setPitch(Number(e.target.value))} /></div>
          <div className="fld"><span className="k">Preferred voices</span><span className="mono">{t.voice.preferredVoices.join(', ') || '—'}</span></div>
        </div>
      </section>
      <div className="grid2">
        <section className="sec"><header><div><h3>Tenant</h3><p className="mono">config/tenants/{t.id}.json</p></div><span className="sb-sample">SAMPLE</span></header>
          <div className="bd">
            <div className="fld"><span className="k">Vertical</span><span style={{ textTransform: 'capitalize' }}>{t.vertical}</span></div>
            <div className="fld"><span className="k">Timezone</span><span className="mono">{t.timezone}</span></div>
            <div className="fld"><span className="k">Policy version</span><span className="mono">{t.policyVersion}</span></div>
            <div className="fld"><span className="k">Rate limit</span><span>{t.rateLimitPerMinute ?? 120} req/min</span></div>
            {t.hotel && <div className="fld"><span className="k">Check-in / out</span><span className="mono">{t.hotel.checkInTime} / {t.hotel.checkOutTime}</span></div>}
          </div></section>
        <section className="sec"><header><div><h3>{t.hotel ? 'Rate card' : 'Treatments'}</h3><p>The only prices agents may quote.</p></div></header>
          <table className="tbl"><tbody>
            {t.hotel ? t.hotel.rooms.map((r) => <tr key={r.type}><td>{r.type}</td><td>{r.maxGuests} guests</td><td className="mono" style={{ textAlign: 'right' }}>{cur}{r.ratePerNight}/night</td></tr>)
              : t.dental!.treatments.map((r) => <tr key={r.name}><td>{r.name}</td><td>{r.durationMin} min</td><td className="mono" style={{ textAlign: 'right' }}>{r.price === null ? 'after assessment' : `£${r.price}`}</td></tr>)}
          </tbody></table></section>
      </div>
      {t.locations.map((l) => (
        <section className="sec" key={l.name}><header><div><h3>{l.name}</h3><p>{l.address} · {l.phone}</p></div></header>
          <div className="bd"><div className="hours" style={{ paddingTop: 8 }}>{DAYS.map(([k, d]) => <div key={k}><span>{d}</span>{l.hours[k]}</div>)}</div></div></section>
      ))}
    </div></div>
  )
}
