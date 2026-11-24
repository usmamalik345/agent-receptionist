import { Mic, RotateCcw, Volume2, VolumeX } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { getSpeechRecognition, speakText, stopSpeaking, type SpeechRecognitionLike } from '../lib/speech'
import { brand, platform, tenantList, tenants, type TurnResult } from './engine'
import { scenariosFor, type Scenario } from './scenarios'
import { useConsole, type Turn } from './state'
import { fmtMs, Inspector } from './ui'

function Stripe({ r }: { r: TurnResult }) {
  const spans = r.trace.spans
  const total = spans.reduce((a, s) => a + s.duration_ms, 0) || 1
  return <div className="stripe" aria-hidden>{spans.map((s, i) => <i key={i} style={{ width: `${(s.duration_ms / total) * 100}%`, background: s.name.startsWith('tool:') ? 'var(--acc)' : s.ok ? 'var(--bar)' : 'var(--bad)', opacity: s.name.startsWith('tool:') ? 1 : 0.35 + 0.65 * ((i % 3) / 2) }} />)}</div>
}

function TurnRow({ x, i, agentName }: { x: Turn; i: number; agentName: string }) {
  const r = x.result
  return (
    <div className="turn">
      <span className="n">{String(i + 1).padStart(2, '0')}</span>
      <div>
        <div className="q">{x.say}</div>
        {r ? <div className="a"><b>{agentName}</b>{r.text}</div> : x.error ? <div className="a" style={{ color: 'var(--bad)' }}>Error: {x.error}</div> : <div className="a"><span className="skel" style={{ display: 'block', width: '50%' }} /></div>}
        {r && (
          <div className="tags">
            {r.handoffs.map((h, j) => <span key={j} className="chip">{h.from} → {h.to}</span>)}
            {r.tools.map((t, j) => <span key={j} className={`chip ${t.ok ? 'acc' : 'bad'}`}>{t.tool}</span>)}
            {r.pendingConfirmation && <span className="chip warn">confirm_id issued</span>}
            {r.booking && <span className="chip acc">booked {r.booking.ref}</span>}
            {r.injection.length > 0 && <span className="chip bad">injection screened</span>}
            {r.guard.blocked && <span className="chip bad">guard blocked</span>}
            {r.escalated && <span className="chip warn">handed to team</span>}
            {r.tokens && <span className="chip">LLM {r.tokens.prompt + r.tokens.completion} tok</span>}
          </div>
        )}
      </div>
      <div className="lat">{x.ms !== undefined && <><span className="mono">{fmtMs(x.ms)} ms</span>{r && <Stripe r={r} />}</>}</div>
    </div>
  )
}

export function TestCallView({ tenantId }: { tenantId: string }) {
  const { calls, startCall, send } = useConsole()
  const t = tenants.get(tenantId)!
  const otherBrand = brand(tenantList.find((x) => x.id !== tenantId && x.vertical === 'hotel')!)
  const scenarios = scenariosFor(t, otherBrand)
  const [callId, setCallId] = useState<string | null>(null)
  const [active, setActive] = useState<string | null>(null)
  const [lastRun, setLastRun] = useState<Record<string, string>>({})
  const [text, setText] = useState('')
  const [voice, setVoice] = useState(false)
  const [listening, setListening] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [notes, setNotes] = useState<Array<{ after: number; text: string }>>([])
  const [prevTenant, setPrevTenant] = useState(tenantId)
  if (prevTenant !== tenantId) { setPrevTenant(tenantId); setCallId(null); setActive(null); setNotes([]) }
  const call = calls.find((c) => c.id === callId) ?? null
  const inputRef = useRef<HTMLInputElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const recRef = useRef<SpeechRecognitionLike | null>(null)
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }) }, [call?.turns.length, call?.busy])
  useEffect(() => () => stopSpeaking(), [])

  const say = (s: string) => {
    if (!voice) return
    if (import.meta.env.VITE_TTS_PROVIDER === 'edge') {
      const a = new Audio(`/api/tts?lang=en&tenant=${encodeURIComponent(tenantId)}&q=${encodeURIComponent(s)}`)
      const fb = () => void speakText(s, 'en', { voiceLocale: t.voice.locale, preferredVoices: t.voice.preferredVoices, rate: t.voice.rate, pitch: t.voice.pitch })
      a.onerror = fb; a.play().catch(fb); return
    }
    void speakText(s, 'en', { voiceLocale: t.voice.locale, preferredVoices: t.voice.preferredVoices, rate: t.voice.rate, pitch: t.voice.pitch })
  }
  const ensureCall = () => {
    if (call) return call
    const c = startCall(tenantId); setCallId(c.id); setNotes([]); say(c.greeting); return c
  }
  async function submit(v = text) {
    const s = v.trim()
    if (!s || call?.busy) return
    setText('')
    const c = ensureCall()
    const r = await send(c.id, s)
    if (r) say(r.text)
    inputRef.current?.focus()
  }
  async function runScenario(sc: Scenario) {
    setActive(sc.id)
    const c = startCall(tenantId, sc.title); setCallId(c.id); setNotes([])
    let last: TurnResult | null = null
    for (const line of sc.lines) { await new Promise((r) => setTimeout(r, 220)); last = await send(c.id, line) }
    const res = !last ? 'error' : last.booking ? 'booked' : last.escalated ? 'handed off' : last.injection.length ? 'screened' : 'answered'
    setLastRun((m) => ({ ...m, [sc.id]: res }))
  }
  function reset() { stopSpeaking(); setCallId(null); setActive(null); setNotes([]); inputRef.current?.focus() }
  function silence() {
    const c = ensureCall()
    const a = platform.silence(tenantId, c.id, 7000)
    if (a.action !== 'wait') { setNotes((n) => [...n, { after: c.turns.length, text: `${a.action === 'reprompt' ? 'Caller silent 7 s → re-prompt' : 'Silent again → hand-off'}: “${a.text}”` }]); say(a.text) }
  }
  function toggleMic() {
    setNotice(null)
    if (listening) { recRef.current?.stop(); return }
    const rec = getSpeechRecognition()
    if (!rec) { setNotice('Voice input needs Chrome or Edge.'); return }
    rec.lang = t.voice.locale; rec.interimResults = true; rec.continuous = false
    rec.onresult = (ev) => {
      let s = ''
      for (let i = 0; i < ev.results.length; i++) s += ev.results[i][0].transcript
      setText(s)
      if (ev.results[ev.results.length - 1]?.isFinal) void submit(s)
    }
    rec.onerror = (ev) => setNotice(ev.error === 'not-allowed' ? 'Microphone permission was denied.' : `Voice input error: ${ev.error}`)
    rec.onend = () => setListening(false)
    recRef.current = rec; setListening(true); rec.start()
  }
  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') { e.preventDefault(); void submit() }
    if (e.key === 'ArrowUp' && e.altKey && call?.turns.length) { e.preventDefault(); setText(call.turns.at(-1)!.say) }
    if (e.key === '.' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); silence() }
    if (e.key === 'm' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); toggleMic() }
  }

  return (
    <div className="runner">
      <section className="sc" aria-label="Scenarios">
        <div className="th">Scenarios · {t.vertical}</div>
        {scenarios.map((sc) => (
          <button key={sc.id} className="case" aria-pressed={active === sc.id} onClick={() => void runScenario(sc)} disabled={Boolean(call?.busy)}>
            <b>{sc.title}</b><span>{sc.lines.length} turn{sc.lines.length > 1 ? 's' : ''} · {sc.kind}</span>
            <span className="st">{active === sc.id && call?.busy ? <span className="chip acc">running</span> : lastRun[sc.id] ? <span className={`chip ${lastRun[sc.id] === 'error' ? 'bad' : ''}`}>last: {lastRun[sc.id]}</span> : <span className="chip">not run</span>}</span>
          </button>
        ))}
        <p style={{ marginTop: 'auto', color: 'var(--t3)', fontSize: 11.5 }}>Same wording as the release-gate evals. Runs on the real agents in this browser.</p>
      </section>
      <section className="conv" aria-label="Call">
        <div className="sb-bar" style={{ borderBottom: '1px solid var(--line)', minHeight: 40 }}>
          <span className="chip">{t.voice.agentName} · {t.voice.locale}</span>
          {call && <span className="chip acc">{call.busy ? 'thinking…' : `${call.turns.length} turn${call.turns.length === 1 ? "" : "s"}`}</span>}
          <div className="sp" />
          <button className="ib" onClick={() => { setVoice((v) => !v); stopSpeaking() }} aria-pressed={voice} aria-label={voice ? 'Mute spoken replies' : 'Speak replies aloud'} title="Speak replies (V)">{voice ? <Volume2 size={16} /> : <VolumeX size={16} />}</button>
          <button className="btn hide-sm" onClick={silence} title="Simulate 7 s of caller silence">Silence 7 s</button>
          <button className="btn" onClick={reset} disabled={!call}><RotateCcw size={13} /> New call</button>
        </div>
        <div className="turns" aria-live="polite">
          {!call ? (
            <div className="empty" style={{ marginTop: 48 }}><h2>Place a test call to {brand(t)}</h2><p>Pick a scenario on the left, or type what a caller would say. Each turn shows the hand-offs, tools and time spent per agent.</p></div>
          ) : (
            <>
              <div className="greet"><b>{t.voice.agentName}</b>{call.greeting}</div>
              {call.turns.map((x, i) => (
                <div key={x.id}>
                  <TurnRow x={x} i={i} agentName={t.voice.agentName} />
                  {notes.filter((n) => n.after === i + 1).map((n, j) => <div key={j} className="turn" style={{ color: 'var(--warn)' }}><span className="n">··</span><div>{n.text}</div><span /></div>)}
                </div>
              ))}
              {notes.filter((n) => n.after === 0).map((n, j) => <div key={j} className="turn" style={{ color: 'var(--warn)' }}><span className="n">··</span><div>{n.text}</div><span /></div>)}
            </>
          )}
          <div ref={endRef} />
        </div>
        <div className="cmd">
          <form className="cmdbox" onSubmit={(e) => { e.preventDefault(); void submit() }}>
            <label htmlFor="sb-input" className="p">caller ›</label>
            <input id="sb-input" ref={inputRef} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} placeholder="Type what the caller says…" maxLength={500} autoComplete="off" />
            <button type="button" className={`btn ${listening ? 'acc' : ''}`} onClick={toggleMic} aria-pressed={listening}><Mic size={13} /> {listening ? 'Listening' : 'Mic'}</button>
          </form>
          <div className="cmdhint" role={notice ? 'alert' : undefined}>
            {notice ? <span style={{ color: 'var(--warn)' }}>{notice}</span> : <><span><kbd>↵</kbd> send</span><span><kbd>⌥↑</kbd> repeat last</span><span><kbd>⌘M</kbd> mic</span><span><kbd>⌘.</kbd> silence 7 s</span><span>SAMPLE business · mock responder</span></>}
          </div>
        </div>
      </section>
      <section className="side" aria-label="Inspector">{call ? <Inspector c={call} t={t} /> : <><div className="th">Inspector</div><p style={{ color: 'var(--t3)', margin: 0 }}>Booking slots, hand-offs, tools and safety checks for the current call appear here.</p></>}</section>
    </div>
  )
}
