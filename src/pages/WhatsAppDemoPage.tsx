import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, MoreVertical, Phone, Smile, Paperclip, Mic } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useBusiness, withBizParam } from '../store/BusinessContext'
import { useDemo } from '../store/DemoContext'

export function WhatsAppDemoPage() {
  const demo = useDemo()
  const { biz, slug, preset } = useBusiness()
  const [input, setInput] = useState('')
  const [typing, setTyping] = useState(false)
  const [started, setStarted] = useState(false)
  const bottom = useRef<HTMLDivElement>(null)
  const { session, settings } = demo

  const waMessages = session.channel === 'whatsapp' ? session.transcript : []
  const chips =
    settings.language === 'ar' ? biz.demoChips.ar || biz.demoChips.en : biz.demoChips.en
  const isRtl = settings.language === 'ar' || session.booking.language === 'ar'
  const customer = preset.wording.customerNoun

  useEffect(() => {
    if (waMessages.length === 0 && !typing) return
    const el = bottom.current
    if (!el) return
    const scroller = el.closest('.overflow-y-auto')
    if (scroller) {
      scroller.scrollTop = scroller.scrollHeight
    } else {
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [waMessages.length, typing])

  const ensureSession = () => {
    if (!started || session.channel !== 'whatsapp' || session.status === 'idle' || session.status === 'completed') {
      demo.startSession('whatsapp')
      setStarted(true)
      setTyping(true)
      setTimeout(() => {
        demo.runGreeting()
        setTyping(false)
      }, 900)
      return true
    }
    return false
  }

  const deliver = (text: string) => {
    const bootstrapping =
      session.channel !== 'whatsapp' || session.status === 'idle' || session.step === 'idle'
    if (bootstrapping) {
      demo.startSession('whatsapp')
      setStarted(true)
      setTyping(true)
      setTimeout(() => {
        demo.runGreeting()
        setTyping(false)
        setTimeout(() => {
          setTyping(true)
          setTimeout(() => {
            demo.sendGuestMessage(text)
            setTyping(false)
          }, 700)
        }, 400)
      }, 600)
      return
    }

    setTyping(true)
    setTimeout(() => {
      demo.sendGuestMessage(text)
      setTyping(false)
    }, 550)
  }

  const send = () => {
    const text = input.trim()
    if (!text || typing) return
    setInput('')
    deliver(text)
  }

  const sendChip = (text: string) => {
    if (typing) return
    deliver(text)
  }

  return (
    <div className="max-w-lg mx-auto animate-fade-up">
      <div className="flex items-center justify-between mb-4 gap-2 flex-wrap">
        <Link
          to={withBizParam('/dashboard', slug)}
          className="text-sm text-[var(--gold)] font-medium flex items-center gap-1"
        >
          <ArrowLeft size={14} /> Back to live demo
        </Link>
        <span className="demo-badge">
          {biz.industry === 'dental' ? 'Patient' : 'Guest'} WhatsApp · simulation
        </span>
      </div>

      <p className="text-sm text-[var(--text-muted)] mb-3 leading-relaxed">
        This is how a <strong className="text-[var(--text)]">{customer}</strong> chats. Desk alerts go to the{' '}
        {biz.industry === 'dental' ? 'practice' : 'hotel'} number on the Live demo page — different thing.
      </p>

      <div className="rounded-2xl overflow-hidden border border-[var(--border)] shadow-[var(--shadow-soft)] flex flex-col h-[min(720px,85vh)] bg-white">
        <div className="bg-[var(--wa-green)] text-white px-3 py-2.5 flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-[rgba(255,255,255,0.2)] flex items-center justify-center text-white font-display text-lg">
            {biz.logoText.slice(0, 2)}
          </div>
          <div className="flex-1 min-w-0">
            <div className="font-medium text-sm truncate">
              {biz.name}
              {biz.industry === 'dental' ? '' : ' Reservations'}
            </div>
            <div className="text-[11px] opacity-90">AI assistant · usually replies instantly</div>
          </div>
          <Phone size={18} className="opacity-90" />
          <MoreVertical size={18} className="opacity-90" />
        </div>

        <div
          className="flex-1 overflow-y-auto p-3 space-y-2"
          style={{
            backgroundColor: '#efeae2',
          }}
        >
          <div className="text-center my-2">
            <span className="inline-block bg-white/90 text-[11px] text-[var(--text-muted)] px-3 py-1 rounded-md border border-[var(--border)]">
              Demo sandbox · {customer} chat simulation
            </span>
          </div>

          {!started && waMessages.length === 0 && (
            <div className="text-center py-6 px-3">
              <button className="btn btn-primary" onClick={() => ensureSession()}>
                Start chat with {biz.industry === 'dental' ? 'practice' : 'reservations'} AI
              </button>
              <p className="text-xs text-[var(--text-muted)] mt-3">
                Or tap a quick question below
                {biz.languages.includes('ar') ? ' (English or Arabic — toggle on dashboard)' : ''}.
              </p>
            </div>
          )}

          {waMessages.map((m) => (
            <div
              key={m.id}
              className={`flex ${m.speaker === 'Guest' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                dir={/[\u0600-\u06FF]/.test(m.text) ? 'rtl' : 'ltr'}
                className={`max-w-[85%] rounded-lg px-3 py-2 text-sm leading-relaxed text-[#111b21] shadow-sm ${
                  m.speaker === 'Guest'
                    ? 'bg-[var(--wa-bubble-out)] rounded-tr-none'
                    : 'bg-[var(--wa-bubble-in)] rounded-tl-none border border-[var(--border)]'
                }`}
              >
                {m.text}
                <div className="text-[10px] opacity-60 text-right mt-1">
                  {new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </div>
              </div>
            </div>
          ))}

          {typing && (
            <div className="flex justify-start">
              <div className="bg-[var(--wa-bubble-in)] rounded-lg rounded-tl-none px-4 py-3 flex gap-1">
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className="w-1.5 h-1.5 rounded-full bg-[var(--text-muted)]"
                    style={{ animation: `typing-dot 1.2s ease-in-out ${i * 0.2}s infinite` }}
                  />
                ))}
              </div>
            </div>
          )}
          <div ref={bottom} />
        </div>

        <div className="bg-[#f0f2f5] px-2 py-2 border-t border-[var(--border)]">
          <div className="flex gap-1.5 overflow-x-auto pb-2 scrollbar-thin">
            {chips.slice(0, 6).map((c) => (
              <button
                key={c.label}
                type="button"
                disabled={typing}
                onClick={() => sendChip(c.text)}
                className="chip shrink-0"
              >
                {c.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Smile size={22} className="text-[var(--text-muted)] shrink-0" />
            <Paperclip size={20} className="text-[var(--text-muted)] shrink-0" />
            <input
              className="flex-1 bg-white border border-[var(--border)] rounded-lg px-3 py-2.5 text-sm outline-none focus:border-[var(--gold)]"
              placeholder={isRtl ? 'اكتب رسالة…' : 'Type a message'}
              value={input}
              dir={isRtl ? 'rtl' : 'ltr'}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && send()}
            />
            <button
              type="button"
              onClick={send}
              className="w-10 h-10 rounded-full bg-[var(--wa-green)] flex items-center justify-center shrink-0 text-white"
              aria-label="Send"
            >
              {input.trim() ? (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="white">
                  <path d="M2 21l21-9L2 3v7l15 2-15 2v7z" />
                </svg>
              ) : (
                <Mic size={18} className="text-white" />
              )}
            </button>
          </div>
        </div>
      </div>

      <p className="text-xs text-[var(--text-muted)] text-center mt-3">
        Same booking brain as voice · Watch the{' '}
        <Link to="/dashboard" className="text-[var(--gold-soft)] underline">
          dashboard
        </Link>{' '}
        update live.
      </p>
    </div>
  )
}
