import { ArrowUp, Mic, RotateCcw, Volume2, VolumeX } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { getSpeechRecognition, speakText, stopSpeaking, type SpeechRecognitionLike } from '../lib/speech'
import { brand, tenants } from './engine'
import { useConsole, type Call, type Msg } from './state'
import { Avatar, TraceTimeline } from './ui'

const SUGGEST: Record<'hotel' | 'dental', Array<[string, string]>> = {
  hotel: [['Book a room', 'I want to book a room from 27 November for 2 nights'], ['Check-in time', 'What time is check-in?'], ['Room prices', 'How much are your rooms?'], ['Parking', 'Is there parking?']],
  dental: [['Book a check-up', 'I need a check-up'], ['Opening hours', 'What time do you close on Friday?'], ['Prices', 'How much is a filling?'], ['New patients', 'Are you taking new patients?']],
}

/** Reveals text word by word (UI streaming effect for a reply that is already computed). */
function useTyping(text: string, active: boolean) {
  const [n, setN] = useState(active ? 0 : Number.MAX_SAFE_INTEGER)
  const words = text.split(/(\s+)/)
  useEffect(() => {
    if (!active) { setN(Number.MAX_SAFE_INTEGER); return }
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduce) { setN(words.length); return }
    let i = 0
    const t = setInterval(() => { i += 2; setN(i); if (i >= words.length) clearInterval(t) }, 28)
    return () => clearInterval(t)
  }, [active, text]) // eslint-disable-line react-hooks/exhaustive-deps
  return { shown: words.slice(0, n).join(''), done: n >= words.length }
}

function BotMessage({ m, t, live }: { m: Msg; t: Call['tenantId']; live: boolean }) {
  const tenant = tenants.get(t)!
  const { shown, done } = useTyping(m.text, live)
  const [open, setOpen] = useState(false)
  const r = m.result
  return (
    <div className="cx-msg bot">
      <Avatar t={tenant} />
      <div>
        <div className={`text${done ? '' : ' cx-cursor'}`} aria-live={live ? 'polite' : undefined}>{shown}</div>
        {r && done && (
          <div className="cx-meta">
            <span className="cx-badge">{r.agent}</span>
            {r.tools.map((x, i) => <span key={i} className={`cx-badge ${x.ok ? '' : 'bad'}`}>{x.tool}</span>)}
            {r.booking && <span className="cx-badge ok">Booked</span>}
            {r.escalated && <span className="cx-badge warn">Handed to team</span>}
            {r.guard.blocked && <span className="cx-badge bad">Guard blocked</span>}
            {r.injection.length > 0 && <span className="cx-badge bad">Injection screened</span>}
            <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}>{open ? 'Hide trace' : 'Trace'}</button>
          </div>
        )}
        {r && open && <TraceTimeline spans={r.trace.spans} />}
      </div>
    </div>
  )
}

export function ChatView({ tenantId }: { tenantId: string }) {
  const { calls, startCall, send } = useConsole()
  const tenant = tenants.get(tenantId)!
  const [callId, setCallId] = useState<string | null>(null)
  const call = calls.find((c) => c.id === callId && c.tenantId === tenantId) ?? null
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [voice, setVoice] = useState(false)
  const [listening, setListening] = useState(false)
  const [micError, setMicError] = useState<string | null>(null)
  const recRef = useRef<SpeechRecognitionLike | null>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const lastBotId = call ? [...call.messages].reverse().find((m) => m.role === 'bot')?.id : undefined

  useEffect(() => { setCallId(null); setText('') }, [tenantId])
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }) }, [call?.messages.length])
  useEffect(() => () => stopSpeaking(), [])

  const browserSay = (t: string) => void speakText(t, 'en', { voiceLocale: tenant.voice.locale, preferredVoices: tenant.voice.preferredVoices, rate: tenant.voice.rate, pitch: tenant.voice.pitch })
  const say = (t: string) => {
    if (!voice) return
    // Optional free server neural voice (edge-tts behind /api/tts, needs the API server). Falls back to the browser voice.
    if (import.meta.env.VITE_TTS_PROVIDER === 'edge') {
      const a = new Audio(`/api/tts?lang=en&tenant=${encodeURIComponent(tenantId)}&q=${encodeURIComponent(t)}`)
      a.play().catch(() => browserSay(t))
      a.onerror = () => browserSay(t)
      return
    }
    browserSay(t)
  }

  async function submit(value = text) {
    const v = value.trim()
    if (!v || busy) return
    setBusy(true)
    setText('')
    const c = call ?? startCall(tenantId)
    if (!call) { setCallId(c.id); say(c.messages[0].text) }
    const r = await send(c, v)
    if ('text' in r) say(r.text)
    setBusy(false)
    inputRef.current?.focus()
  }
  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit() }
  }
  function toggleMic() {
    setMicError(null)
    if (listening) { recRef.current?.stop(); return }
    const rec = getSpeechRecognition()
    if (!rec) { setMicError('Voice input needs Chrome or Edge.'); return }
    rec.lang = tenant.voice.locale
    rec.interimResults = true
    rec.continuous = false
    rec.onresult = (ev) => {
      let s = ''
      for (let i = 0; i < ev.results.length; i++) s += ev.results[i][0].transcript
      setText(s)
      const last = ev.results[ev.results.length - 1]
      if (last?.isFinal) void submit(s)
    }
    rec.onerror = (ev) => setMicError(ev.error === 'not-allowed' ? 'Microphone permission was denied.' : `Voice input error: ${ev.error}`)
    rec.onend = () => setListening(false)
    recRef.current = rec
    setListening(true)
    rec.start()
  }

  return (
    <div className="cx-chat">
      <div className="cx-top">
        <h1>Test call</h1>
        <span className="cx-badge">{brand(tenant)}</span>
        <div className="spacer" />
        <button className="cx-icon-btn" type="button" onClick={() => { setVoice((v) => !v); stopSpeaking() }} aria-pressed={voice} aria-label={voice ? 'Mute spoken replies' : 'Speak replies aloud'} title={voice ? 'Voice on' : 'Voice off'}>
          {voice ? <Volume2 size={17} /> : <VolumeX size={17} />}
        </button>
        <button className="cx-btn ghost" type="button" onClick={() => { setCallId(null); stopSpeaking() }} disabled={!call}><RotateCcw size={15} /> New call</button>
      </div>
      <div className="cx-thread">
        <div className="cx-col">
          {!call ? (
            <div className="cx-empty">
              <h2>Talk to {tenant.voice.agentName} at {brand(tenant)}</h2>
              <p>Type or use the mic. Every reply goes through triage, a specialist agent and the guard; open a reply's trace to see each step.</p>
              <div className="cx-suggest">
                {SUGGEST[tenant.vertical].map(([label, q]) => (
                  <button key={label} type="button" onClick={() => void submit(q)}>{label}<small>{q}</small></button>
                ))}
              </div>
            </div>
          ) : (
            call.messages.map((m) => m.role === 'user'
              ? <div key={m.id} className="cx-msg user"><div className="bubble">{m.text}</div></div>
              : <BotMessage key={m.id} m={m} t={call.tenantId} live={m.id === lastBotId && call.messages.length > 1} />)
          )}
          {busy && <div className="cx-msg bot"><Avatar t={tenant} /><div className="text cx-cursor" aria-label="Thinking" /></div>}
          <div ref={endRef} />
        </div>
      </div>
      <div className="cx-composer-wrap">
        <form className="cx-composer" onSubmit={(e) => { e.preventDefault(); void submit() }}>
          <label htmlFor="cx-input" className="sr">Message</label>
          <textarea id="cx-input" ref={inputRef} rows={1} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} placeholder={`Message ${brand(tenant)}…`} maxLength={500} />
          <button type="button" className="cx-icon-btn mic" onClick={toggleMic} aria-pressed={listening} aria-label={listening ? 'Stop listening' : 'Speak'}><Mic size={18} /></button>
          <button type="submit" className="send" disabled={!text.trim() || busy} aria-label="Send"><ArrowUp size={18} /></button>
        </form>
        <p className="cx-hint" role={micError ? 'alert' : undefined}>{micError ?? 'SAMPLE business · runs in your browser · Enter to send, Shift+Enter for a new line'}</p>
      </div>
    </div>
  )
}
