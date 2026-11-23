import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  History,
  Languages,
  MessageSquare,
  Mic,
  Moon,
  PhoneForwarded,
  Play,
  RotateCcw,
  UserRound,
} from 'lucide-react'
import { DEMO_CHIPS } from '../config/knowledge'
import { CallStatusBadge } from '../components/CallStatusBadge'
import { CostDifferencePanel } from '../components/CostDifferencePanel'
import { CompetitorParitySection } from '../components/CompetitorFeaturePanels'
import {
  ItOpsPanel,
  KnowledgeSearchPanel,
  OperaGatePanel,
  ReturningGuestHint,
} from '../components/ItAdvancedPanels'
import { outcomeLabel, type Language, type StaffTicket } from '../lib/types'
import {
  getSpeechRecognition,
  hasLiveSpeech,
  preloadVoices,
  readFullTranscript,
  sampleScriptLines,
  speakGreeting,
  speakText,
  stopSpeaking,
  isGreetingAudioPlaying,
  unlockAudioPlayback,
  waitForVoiceIdle,
  warmupTts,
} from '../lib/speech'
import {
  fetchBridgeHealth,
  loadDeskWhatsAppOverride,
  saveDeskWhatsAppOverride,
  sendMissedCallWhatsApp,
  type BridgeHealth,
  type MissedCallResult,
} from '../lib/twilioBridge'
import { useBusiness } from '../store/BusinessContext'
import { useDemo } from '../store/DemoContext'

export function DashboardPage() {
  const demo = useDemo()
  const { biz, preset } = useBusiness()
  const { session, settings, notifications, history, tickets, sessions } = demo
  const isDental = biz.industry === 'dental'
  const customer = preset.wording.customerNoun
  const paused = settings.aiPaused
  const [overflowNote, setOverflowNote] = useState('')
  const [voiceMode, setVoiceMode] = useState<'idle' | 'live' | 'scripted' | 'fallback'>('idle')
  const [listening, setListening] = useState(false)
  const [fallbackInput, setFallbackInput] = useState('')
  const [scriptRunning, setScriptRunning] = useState(false)
  const [lineBanner, setLineBanner] = useState<null | 'desk_miss' | 'ai_cover'>(null)
  const [deskWa, setDeskWa] = useState(() => loadDeskWhatsAppOverride())
  const [bridge, setBridge] = useState<BridgeHealth | null>(null)
  const [waSend, setWaSend] = useState<MissedCallResult | null>(null)
  const [waBusy, setWaBusy] = useState(false)
  const [micHint, setMicHint] = useState('')
  const [interimText, setInterimText] = useState('')
  const [aiSpeaking, setAiSpeaking] = useState(false)
  const waSentForSession = useRef<string | null>(null)
  const waSentTicket = useRef<string | null>(null)
  const transcriptEnd = useRef<HTMLDivElement>(null)
  const abortScript = useRef(false)
  const recognitionRef = useRef<ReturnType<typeof getSpeechRecognition>>(null)
  const listenGeneration = useRef(0)
  const transcriptBufferRef = useRef('')
  const finalizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const aiSpeakingRef = useRef(false)
  const micSubmittingRef = useRef(false)
  const beginListeningRef = useRef<() => void>(() => {})

  const MIC_SILENCE_MS = 1500
  const MIN_HEARD_CHARS = 2

  const clearFinalizeTimer = () => {
    if (finalizeTimerRef.current) {
      clearTimeout(finalizeTimerRef.current)
      finalizeTimerRef.current = null
    }
  }

  useEffect(() => {
    if (session.transcript.length === 0) return
    const el = transcriptEnd.current
    if (!el) return
    const scroller = el.closest('.overflow-y-auto')
    if (scroller) {
      scroller.scrollTop = scroller.scrollHeight
    } else {
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [session.transcript.length])

  useEffect(() => () => stopSpeaking(), [])

  useEffect(() => {
    preloadVoices()
    try {
      ;['/audio/greeting-en.wav', '/audio/greeting-ar.mp3'].forEach((src) => {
        const a = new Audio(src)
        a.preload = 'auto'
        void a.load()
      })
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    fetchBridgeHealth()
      .then(setBridge)
      .catch(() =>
        setBridge({
          ok: false,
          twilioConfigured: false,
          deskWhatsAppSet: false,
          readyToSend: false,
          tip: 'API offline — run npm run dev:all',
        }),
      )
  }, [])

  const pushRealWhatsApp = async (booking: {
    guestName?: string
    phone?: string
    checkIn?: string
    checkOut?: string
    adults?: number | null
    children?: number | null
    specialRequests?: string
  }) => {
    setWaBusy(true)
    setWaSend(null)
    try {
      const result = await sendMissedCallWhatsApp({
        guestName: booking.guestName || 'Ahmed Al Mansoori',
        phone: booking.phone || '+971 50 555 5555',
        checkIn: booking.checkIn || '2026-10-10',
        checkOut: booking.checkOut || '2026-10-13',
        adults: booking.adults ?? 2,
        children: booking.children ?? 1,
        specialRequests: booking.specialRequests || 'Late check-in after 10pm',
        ...(deskWa.trim() ? { to: deskWa.trim() } : {}),
      })
      setWaSend(result)
      const health = await fetchBridgeHealth().catch(() => null)
      if (health) setBridge(health)
      return result
    } catch {
      const err = { ok: false as const, error: 'offline' }
      setWaSend(err)
      return err
    } finally {
      setWaBusy(false)
    }
  }

  const startScriptedVoice = async (lang: Language, opts?: { missedDesk?: boolean }) => {
    warmupTts()
    unlockAudioPlayback()
    abortScript.current = false
    setScriptRunning(true)
    setVoiceMode('scripted')
    stopSpeaking()
    const missed = Boolean(opts?.missedDesk)
    if (missed) {
      demo.setSettings({ language: lang, afterHours: true })
      setLineBanner('desk_miss')
      setWaSend(null)
    } else {
      demo.setSettings({ language: lang })
      setLineBanner(null)
    }
    if (lang === 'ar') {
      setMicHint('Arabic voice on · neural TTS (Zariyah)')
    }
    demo.startSession('scripted')
    demo.setStatus('ringing')
    // Missed path: longer ring so Hany sees “desk not answering” before AI covers
    await delay(missed ? 2800 : 800)
    if (abortScript.current) {
      setScriptRunning(false)
      setLineBanner(null)
      return
    }
    if (missed) setLineBanner('ai_cover')
    demo.setStatus('in_call')

    const lines = sampleScriptLines(lang)
    let firstAi = true
    for (let i = 0; i < lines.length; i++) {
      if (abortScript.current) break
      const line = lines[i]
      await delay(line.delayMs)
      if (abortScript.current) break

      if (line.speaker === 'Guest') {
        demo.applyScriptedTurn('Guest', line.text, {
          guestName: 'Ahmed Al Mansoori',
          phone: '+971 50 555 5555',
          checkIn: '2026-10-10',
          checkOut: '2026-10-13',
          rooms: 1,
          adults: 2,
          children: 1,
          specialRequests:
            lang === 'ar' ? 'تسجيل وصول متأخر بعد الساعة 10 مساءً' : 'Late check-in after 10pm',
          language: lang,
        })
      } else {
        demo.applyScriptedTurn('AI', line.text)
        if (lang === 'ar' && firstAi) {
          firstAi = false
          await speakGreeting('ar')
        } else {
          firstAi = false
          await speakText(line.text, lang, { retry: true })
        }
      }
    }

    if (!abortScript.current) {
      demo.finalizeScriptedBooking()
      // Always fire real desk WhatsApp when Meta/bridge is up (Sample call + Missed call)
      await pushRealWhatsApp({
        guestName: 'Ahmed Al Mansoori',
        phone: '+971 50 555 5555',
        checkIn: '2026-10-10',
        checkOut: '2026-10-13',
        adults: 2,
        children: 1,
        specialRequests: missed
          ? 'Late check-in after 10pm · missed desk pickup'
          : 'Late check-in after 10pm · sample call desk alert',
      })
    }
    setScriptRunning(false)
    setVoiceMode('idle')
    if (!abortScript.current && missed) {
      setLineBanner('ai_cover')
    } else {
      setLineBanner(null)
    }
  }

  /** Meeting path: desk miss → YOU talk on mic as guest → AI answers → desk WhatsApp */
  const startMissedCallDemo = async () => {
    unlockAudioPlayback()
    abortScript.current = true
    stopMic()
    setScriptRunning(false)
    setWaSend(null)
    waSentForSession.current = null
    const lang = settings.language
    demo.setSettings({ language: lang, afterHours: true })
    setLineBanner('desk_miss')
    setMicHint('Desk ringing… nobody picking up')
    setAiSpeaking(false)
    setInterimText('')
    demo.startSession('voice')
    demo.setStatus('ringing')
    await delay(2800)
    setLineBanner('ai_cover')
    demo.setStatus('in_call')
    setMicHint(
      lang === 'ar'
        ? 'ردّ المساعد. تحدّث الآن كضيف (اسمح بالمايك).'
        : 'AI answered. Speak now as the guest (allow mic).',
    )

    demo.runGreeting()
    const live = hasLiveSpeech()
    setVoiceMode(live ? 'live' : 'fallback')
    setAiSpeaking(true)
    try {
      await speakGreeting(lang)
    } finally {
      setAiSpeaking(false)
    }
    await waitForVoiceIdle()
    await delay(300)

    if (live) {
      setMicHint('Speak your full sentence, then pause ~1.5s (or tap Send when you see your words)')
      beginListening()
    } else {
      setMicHint('Mic not available in this browser — type as guest below (same AI).')
      setVoiceMode('fallback')
    }
  }

  const startLiveVoice = async () => {
    stopMic()
    abortScript.current = true
    waSentForSession.current = null
    setLineBanner(null)
    demo.startSession('voice')
    demo.setStatus('ringing')
    setMicHint('Connecting…')
    await delay(600)
    demo.setStatus('in_call')

    demo.runGreeting()
    setVoiceMode(hasLiveSpeech() ? 'live' : 'fallback')
    setAiSpeaking(true)
    try {
      await speakGreeting(settings.language)
    } finally {
      setAiSpeaking(false)
    }
    await waitForVoiceIdle()
    await delay(300)

    if (!hasLiveSpeech()) {
      setVoiceMode('fallback')
      setMicHint('Mic unavailable — type as guest below.')
      return
    }

    setMicHint('Listening… talk as the guest')
    beginListening()
  }

  const speakAi = async (
    text: string,
    lang: Language = settings.language,
    opts?: { skipCancel?: boolean; retry?: boolean },
  ) => {
    aiSpeakingRef.current = true
    setAiSpeaking(true)
    setListening(false)
    try {
      await speakText(text, lang, { retry: lang === 'ar', ...opts })
    } finally {
      aiSpeakingRef.current = false
      setAiSpeaking(false)
    }
  }

  const stopMic = () => {
    listenGeneration.current += 1
    clearFinalizeTimer()
    transcriptBufferRef.current = ''
    micSubmittingRef.current = false
    try {
      recognitionRef.current?.abort()
    } catch {
      /* ignore */
    }
    recognitionRef.current = null
    setListening(false)
    setInterimText('')
  }

  const flushMicTranscript = async () => {
    const gen = listenGeneration.current
    clearFinalizeTimer()
    const text = transcriptBufferRef.current.trim()
    if (text.length < MIN_HEARD_CHARS || micSubmittingRef.current) return
    if (gen !== listenGeneration.current) return

    micSubmittingRef.current = true
    transcriptBufferRef.current = ''
    setInterimText('')
    setListening(false)
    try {
      recognitionRef.current?.stop()
    } catch {
      /* ignore */
    }

    setMicHint(`Heard: “${text}”`)
    const reply = demo.sendGuestMessage(text)
    await speakAi(reply, settings.language)
    await waitForVoiceIdle()
    await delay(900)
    if (gen !== listenGeneration.current) {
      micSubmittingRef.current = false
      return
    }

    micSubmittingRef.current = false
    const step = loadStep()
    if (step !== 'completed' && step !== 'escalated') {
      setMicHint('Your turn — full sentence, pause when done, or tap Send')
      beginListeningRef.current()
    } else {
      setVoiceMode('idle')
      setMicHint('Done — check booking fields + desk WhatsApp')
    }
  }

  const beginListening = () => {
    if (aiSpeakingRef.current || micSubmittingRef.current) return

    const synth = typeof window !== 'undefined' ? window.speechSynthesis : null
    if (!synth?.speaking && !synth?.pending && !isGreetingAudioPlaying()) stopSpeaking()

    const rec = getSpeechRecognition()
    if (!rec) {
      setVoiceMode('fallback')
      setMicHint('Mic not supported here — type as guest below.')
      return
    }

    try {
      recognitionRef.current?.abort()
    } catch {
      /* ignore */
    }

    clearFinalizeTimer()
    transcriptBufferRef.current = ''

    const gen = ++listenGeneration.current
    recognitionRef.current = rec
    rec.continuous = true
    rec.interimResults = true
    rec.maxAlternatives = 3
    rec.lang = settings.language === 'ar' ? 'ar-SA' : 'en-US'

    setVoiceMode('live')
    setListening(true)
    setInterimText('')
    setMicHint('Listening… say your full request, pause ~1.5s when finished')

    rec.onstart = () => {
      if (gen !== listenGeneration.current) return
      setListening(true)
    }

    rec.onresult = (ev) => {
      if (gen !== listenGeneration.current || micSubmittingRef.current) return
      const heard = readFullTranscript(ev)
      if (!heard) return
      transcriptBufferRef.current = heard
      setInterimText(heard)
      clearFinalizeTimer()
      finalizeTimerRef.current = setTimeout(() => {
        void flushMicTranscript()
      }, MIC_SILENCE_MS)
    }

    rec.onerror = (ev) => {
      if (gen !== listenGeneration.current) return
      const err = ev.error
      if (err === 'aborted') return
      if (err === 'no-speech') {
        if (transcriptBufferRef.current.trim().length >= MIN_HEARD_CHARS) {
          void flushMicTranscript()
          return
        }
        setMicHint('Didn’t catch that — speak a bit louder, full sentence')
        setTimeout(() => {
          if (gen === listenGeneration.current) beginListeningRef.current()
        }, 400)
        return
      }
      if (err === 'audio-capture' || err === 'not-allowed') {
        setListening(false)
        setVoiceMode('fallback')
        setMicHint('Mic blocked — allow microphone, or type as guest below.')
        return
      }
      setListening(false)
      setMicHint(`Mic hiccup (${err}) — try again or type below`)
      setTimeout(() => {
        if (gen === listenGeneration.current) beginListeningRef.current()
      }, 500)
    }

    rec.onend = () => {
      if (gen !== listenGeneration.current || aiSpeakingRef.current || micSubmittingRef.current) return
      if (transcriptBufferRef.current.trim().length >= MIN_HEARD_CHARS) {
        void flushMicTranscript()
        return
      }
      setListening(false)
      setTimeout(() => {
        if (gen === listenGeneration.current && !aiSpeakingRef.current) beginListeningRef.current()
      }, 350)
    }

    try {
      rec.start()
    } catch {
      setVoiceMode('fallback')
      setMicHint('Could not start mic — type as guest below.')
    }
  }

  beginListeningRef.current = beginListening

  const loadStep = () => {
    try {
      const raw = localStorage.getItem('desert-palm-receptionist-demo-v1')
      if (!raw) return 'await_intent'
      return JSON.parse(raw).session?.step ?? 'await_intent'
    } catch {
      return 'await_intent'
    }
  }

  const submitFallback = async (preset?: string) => {
    const text = (preset ?? fallbackInput).trim()
    if (!text) return
    warmupTts()
    if (!preset) setFallbackInput('')
    if (session.status === 'idle' || session.step === 'idle') {
      demo.startSession('voice')
      const g = demo.runGreeting()
      setVoiceMode('fallback')
      await speakText(g, settings.language)
      await delay(400)
    }
    const reply = demo.sendGuestMessage(text)
    setVoiceMode('fallback')
    await speakText(reply, settings.language)
  }

  const resetAll = () => {
    abortScript.current = true
    stopMic()
    stopSpeaking()
    setScriptRunning(false)
    setVoiceMode('idle')
    setListening(false)
    setAiSpeaking(false)
    setInterimText('')
    setLineBanner(null)
    setMicHint('')
    demo.resetDemo()
  }

  const b = session.booking
  const latestNotify = notifications[0]

  // Live mic / typed path: send desk WhatsApp once when inquiry completes
  useEffect(() => {
    if (session.channel === 'scripted') return
    const ended =
      session.outcome === 'after_hours_saved' ||
      session.outcome === 'booked_inquiry' ||
      session.step === 'completed'
    if (!ended || !session.id) return
    if (waSentForSession.current === session.id) return
    if (!b.guestName && !latestNotify) return
    waSentForSession.current = session.id
    void pushRealWhatsApp({
      guestName: b.guestName || 'Guest',
      phone: b.phone || '-',
      checkIn: b.checkIn || '-',
      checkOut: b.checkOut || '-',
      adults: b.adults,
      children: b.children,
      specialRequests:
        [b.specialRequests, b.roomCategory ? `Prefer ${b.roomCategory}` : '', settings.afterHours ? 'After-hours inquiry' : '']
          .filter(Boolean)
          .join(' · ') || 'Live demo inquiry',
    })
  }, [
    session.channel,
    session.outcome,
    session.step,
    session.id,
    b.guestName,
    b.phone,
    b.checkIn,
    b.checkOut,
    b.adults,
    b.children,
    b.specialRequests,
    b.roomCategory,
    settings.afterHours,
    latestNotify,
  ])

  // Priority ops tickets (AC / ENG) → real desk WhatsApp once
  useEffect(() => {
    const top = tickets.find((t) => t.priority === 'high' && t.status === 'open')
    if (!top || waSentTicket.current === top.id) return
    if (session.channel === 'scripted') return
    waSentTicket.current = top.id
    void pushRealWhatsApp({
      guestName: top.guestName || 'Guest',
      phone: top.phone || '-',
      checkIn: b.checkIn || '-',
      checkOut: b.checkOut || '-',
      adults: b.adults,
      children: b.children,
      specialRequests: `PRIORITY TICKET: ${top.reason} · ${top.summary}`,
    })
  }, [tickets, session.channel, b.checkIn, b.checkOut, b.adults, b.children])

  const chips =
    settings.language === 'ar'
      ? biz.demoChips.ar || biz.demoChips.en || DEMO_CHIPS.ar
      : biz.demoChips.en || DEMO_CHIPS.en
  const coreLabelsEn = isDental
    ? chips.map((c) => c.label)
    : [
        '2 couples',
        'Which room types?',
        'Pick room 4',
        'AC broken Rm 412',
        'Add breakfast (2)',
        'Talk to human',
      ]
  const coreLabelsAr = ['زوجان اثنان', 'أنواع الغرف؟', 'مكيف معطل ٤١٢', 'غرف منفصلة', 'الفطور مجاني؟', 'موظف']
  const coreLabels = settings.language === 'ar' && !isDental ? coreLabelsAr : coreLabelsEn
  const coreChips = chips.filter((c) => coreLabels.includes(c.label)).slice(0, isDental ? 8 : 6)
  const orderedCore = coreLabels
    .map((label) => chips.find((c) => c.label === label))
    .filter((c): c is (typeof chips)[number] => !!c)
  const visibleCore = orderedCore.length ? orderedCore : coreChips

  const faqsAnswered = session.toolLogs.filter((l) => {
    if (l.tool !== 'detect_intent') return false
    const intent = String((l.args as { intent?: string } | undefined)?.intent || '')
    return intent === 'faq' || /faq|greeting|Language/i.test(String(l.result))
  }).length
  const inquiriesSaved = history.filter(
    (h) => h.outcome === 'booked_inquiry' || h.outcome === 'after_hours_saved',
  ).length
  const openTickets = tickets.filter((t) => t.status !== 'done').length
  const deskAlerts = notifications.length
  const afterHoursOn = settings.afterHours
  const overflowReady = Math.max(0, 5 - (sessions?.length || 1))

  return (
    <div className="space-y-6 animate-fade-up">
      {/* Immersive stage — one clear action */}
      <section className="stage p-6 md:p-8">
        <div className="flex flex-wrap items-center gap-2 mb-5">
          <span className="demo-badge on-stage">DEMO</span>
          <CallStatusBadge status={session.status} />
          {afterHoursOn && (
            <span className="demo-badge on-stage" title="After-hours mode">
              After-hours ON
            </span>
          )}
          {paused && (
            <span className="demo-badge on-stage" title="IT kill switch">
              AI PAUSED
            </span>
          )}
          {bridge?.readyToSend && (
            <span className="text-xs text-[rgba(232,244,242,0.75)]">Desk WA ready · {bridge.provider}</span>
          )}
          {!settings.operaWriteUnlocked && !isDental && (
            <span className="text-xs text-[rgba(232,244,242,0.65)]">Opera write LOCKED</span>
          )}
        </div>
        <div className="grid lg:grid-cols-[1.2fr_0.8fr] gap-8 items-end">
          <div>
            <p className="text-sm uppercase tracking-[0.18em] text-[rgba(232,244,242,0.65)] mb-3">
              AI receptionist
            </p>
            <h1 className="font-display text-4xl md:text-5xl leading-[1.05] text-white max-w-xl">
              {biz.propertyLabel || biz.name}
            </h1>
            <p className="mt-4 text-base text-[rgba(232,244,242,0.82)] max-w-md leading-relaxed">
              {isDental
                ? `You are the ${customer}. Talk into the mic — AI answers out loud. Appointment requests go to the practice team (not a live diary).`
                : `You are the ${customer}. Talk into the mic — AI answers out loud. When the booking is saved, desk gets WhatsApp.`}
            </p>
            <div className="mt-6 flex flex-wrap gap-2">
              <button
                className="btn btn-primary text-base px-6 py-3"
                onPointerDown={() => {
                  warmupTts()
                  unlockAudioPlayback()
                }}
                onClick={() => void startMissedCallDemo()}
                disabled={scriptRunning}
              >
                <Mic size={18} /> Talk to AI (missed call)
              </button>
              <button
                className="btn btn-secondary"
                onPointerDown={() => {
                  warmupTts()
                  unlockAudioPlayback()
                }}
                onClick={() => void startLiveVoice()}
                disabled={scriptRunning}
              >
                <Mic size={16} /> Mic only
              </button>
              <button className="btn btn-secondary" onClick={() => startScriptedVoice('en', { missedDesk: true })} disabled={scriptRunning}>
                <Play size={16} /> Auto sample (backup)
              </button>
              {!isDental && (
                <button className="btn btn-secondary" onClick={() => startScriptedVoice('ar')} disabled={scriptRunning}>
                  <Play size={16} /> عيّنة AR
                </button>
              )}
              {isDental && (
                <a className="btn btn-secondary" href="/record-demo?biz=mm-dental">
                  <Play size={16} /> Record demo
                </a>
              )}
              <button className="btn btn-secondary" onClick={resetAll}>
                <RotateCcw size={16} /> Reset
              </button>
            </div>
            <div className="mt-6 flex flex-col items-start gap-3">
              <div
                className={`voice-orb ${
                  aiSpeaking ? 'speaking' : listening ? 'listening' : 'idle'
                }`}
                aria-live="polite"
              >
                {aiSpeaking || listening ? (
                  <div className="voice-bars" aria-hidden>
                    <span /><span /><span /><span /><span />
                  </div>
                ) : (
                  <Mic size={28} />
                )}
              </div>
              <div>
                <p className="text-sm font-semibold text-[#5eead4]">
                  {aiSpeaking
                    ? 'AI speaking…'
                    : listening
                      ? 'Listening to you…'
                      : micHint || 'Press the button, then talk'}
                </p>
                {listening && interimText && (
                  <div className="flex flex-wrap items-center gap-2 mt-1">
                    <p className="interim-pill flex-1 min-w-0">Hearing: {interimText}</p>
                    <button
                      type="button"
                      className="btn btn-secondary text-xs py-1.5 shrink-0"
                      onClick={() => void flushMicTranscript()}
                    >
                      Send
                    </button>
                  </div>
                )}
                {!listening && !aiSpeaking && micHint && (
                  <p className="text-xs text-[rgba(232,244,242,0.7)] mt-1">{micHint}</p>
                )}
              </div>
            </div>
          </div>

          <div className="flow-rail animate-drift">
            <div className="flow-node">
              <div className="text-xs opacity-70 mb-1">Step 1</div>
              <div className="font-semibold text-sm">Missed call</div>
            </div>
            <div className="flow-arrow">→</div>
            <div className="flow-node">
              <div className="text-xs opacity-70 mb-1">Step 2</div>
              <div className="font-semibold text-sm">AI helps</div>
            </div>
            <div className="flow-arrow">→</div>
            <div className="flow-node">
              <div className="text-xs opacity-70 mb-1">Step 3</div>
              <div className="font-semibold text-sm">Desk WhatsApp</div>
            </div>
          </div>
        </div>
      </section>

      {/* Owner-impress ROI strip */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <div className="panel px-4 py-3">
          <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Inquiries saved</div>
          <div className="font-display text-2xl text-[var(--gold-soft)]">{inquiriesSaved}</div>
        </div>
        <div className="panel px-4 py-3">
          <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Desk alerts</div>
          <div className="font-display text-2xl text-[var(--gold-soft)]">{deskAlerts}</div>
        </div>
        <div className="panel px-4 py-3">
          <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Open tickets</div>
          <div className="font-display text-2xl text-[var(--gold-soft)]">{openTickets}</div>
        </div>
        <div className="panel px-4 py-3">
          <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">FAQ turns</div>
          <div className="font-display text-2xl text-[var(--gold-soft)]">{faqsAnswered}</div>
        </div>
        <div className="panel px-4 py-3">
          <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Invented rates</div>
          <div className="font-display text-2xl text-[var(--success)]">0</div>
        </div>
      </div>

      {/* Concurrent overflow — hotel / hospitality only */}
      {!isDental && (
      <div className="panel px-4 py-3 space-y-3">
        <div className="flex flex-wrap items-start gap-3">
          <PhoneForwarded size={18} className="text-[var(--gold)] shrink-0 mt-0.5" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-[var(--gold-soft)]">
              Overflow lines · {(sessions || [session]).length}/5 active
            </div>
            <p className="text-xs text-[var(--text-muted)] mt-0.5 leading-snug">
              Spawn parallel callers for the meeting demo — each line opens a ticket + desk WhatsApp. Click a line to switch
              the live conversation panel.
            </p>
          </div>
          <button
            type="button"
            className="btn btn-light text-xs"
            disabled={scriptRunning || overflowReady <= 0}
            onClick={() => {
              const note = demo.spawnOverflowLine()
              setOverflowNote(note || '')
            }}
          >
            + Spawn parallel call
          </button>
        </div>
        <div className="flex flex-wrap gap-1.5" aria-label="Demo line status">
          {Array.from({ length: 5 }, (_, i) => {
            const lineNo = i + 1
            const s = (sessions || []).find((x) => x.line === lineNo)
            const isActive = s?.id === session.id
            const live = Boolean(s)
            return (
              <button
                key={lineNo}
                type="button"
                disabled={!s}
                onClick={() => s && demo.switchSession(s.id)}
                className={`text-[10px] uppercase tracking-wide px-2 py-1 rounded border ${
                  isActive
                    ? 'border-[rgba(15,118,110,0.65)] bg-[rgba(15,118,110,0.2)] text-[var(--gold-soft)]'
                    : live
                      ? 'border-[rgba(15,118,110,0.35)] bg-[rgba(15,118,110,0.08)] text-[var(--gold-soft)]'
                      : 'border-[var(--border)] text-[var(--text-muted)]'
                }`}
                title={s ? `${s.booking.guestName || 'Guest'} · ${s.status}` : 'Empty'}
              >
                Line {lineNo}{' '}
                {s
                  ? s.status === 'completed'
                    ? 'done'
                    : isActive
                      ? 'focus'
                      : 'live'
                  : 'ready'}
              </button>
            )
          })}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]">
          <span>{overflowReady} slots free</span>
          {overflowNote && <span className="text-[var(--gold)]">{overflowNote}</span>}
          {(sessions || []).length > 1 && session.status === 'completed' && (
            <button
              type="button"
              className="btn btn-ghost text-xs py-1"
              onClick={() => demo.closeSessionLine(session.id)}
            >
              Close this line
            </button>
          )}
        </div>
      </div>
      )}

      {lineBanner && (
        <div className="panel p-4 flex flex-wrap items-center gap-3 border-[rgba(15,118,110,0.35)]" role="status">
          <PhoneForwarded size={18} className="text-[var(--gold)] shrink-0" />
          <div className="text-sm leading-snug">
            {lineBanner === 'desk_miss' ? (
              <>
                <span className="font-semibold text-[var(--gold-soft)]">Desk not answering</span>
                <span className="text-[var(--text-muted)]"> · line ringing · no staff pickup</span>
              </>
            ) : (
              <>
                <span className="font-semibold text-[var(--gold-soft)]">AI covering the line</span>
                <span className="text-[var(--text-muted)]">
                  {waSend?.ok
                    ? ' · inquiry saved · desk alert sent'
                    : waBusy
                      ? ' · inquiry saved · desk alert sending'
                      : waSend && (waSend.error === 'offline' || !bridge?.readyToSend)
                        ? ' · inquiry saved · demo mode'
                        : ' · inquiry saved'}
                </span>
              </>
            )}
          </div>
          <span className="demo-badge ml-auto">Live</span>
        </div>
      )}

      {!isDental && <ReturningGuestHint />}

      {/* Advanced IT pack — hotel / hospitality only */}
      {!isDental && (
        <>
          <div className="grid lg:grid-cols-2 gap-4">
            <ItOpsPanel />
            <OperaGatePanel />
          </div>
          <KnowledgeSearchPanel />
          <CompetitorParitySection />
        </>
      )}

      {/* Main workspace: conversation + results */}
      <div className="grid lg:grid-cols-[1.15fr_0.85fr] gap-5">
        <div className="chat-shell">
          <div className="chat-shell-head">
            <div>
              <div className="font-display text-lg text-[var(--gold-soft)]">
                Live conversation
                {(sessions?.length || 0) > 1 ? ` · Line ${session.line || 1}` : ''}
              </div>
              <div className="text-xs text-[var(--text-muted)]">
                {listening
                  ? 'Mic listening…'
                  : voiceMode === 'scripted'
                    ? 'Playing sample call…'
                    : bridge?.readyToSend
                      ? `Desk alerts ready · ${bridge.provider}`
                      : isDental
                        ? 'What the caller hears / chats'
                        : 'What the guest hears / chats'}
              </div>
            </div>
            <a className="btn btn-ghost text-xs py-1.5" href={`/whatsapp-demo?biz=${biz.slug}`}>
              <MessageSquare size={14} /> {isDental ? 'Patient chat UI' : 'Guest chat UI'}
            </a>
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-3 max-h-[480px]">
            {session.transcript.length === 0 && (
              <div className="h-full min-h-[200px] flex items-center justify-center text-center px-6">
                <div>
                  <p className="font-display text-xl text-[var(--gold-soft)]">Ready when you are</p>
                  <p className="text-sm text-[var(--text-muted)] mt-2">
                    Press <strong>Talk to AI (missed call)</strong> above — talk appears here.
                  </p>
                </div>
              </div>
            )}
            {session.transcript.map((t) => (
              <div
                key={t.id}
                className={`flex ${t.speaker === 'Guest' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[90%] px-3.5 py-2.5 text-sm leading-relaxed shadow-sm ${
                    t.speaker === 'Guest' ? 'bubble-guest' : 'bubble-ai'
                  }`}
                  dir={/[\u0600-\u06FF]/.test(t.text) ? 'rtl' : 'ltr'}
                >
                  <div className="text-[10px] uppercase tracking-wide opacity-70 mb-1">
                    {t.speaker === 'Guest' ? (isDental ? 'Caller' : 'Guest') : t.speaker}
                  </div>
                  {t.text}
                </div>
              </div>
            ))}
            <div ref={transcriptEnd} />
          </div>
          <div className="p-3 border-t border-[var(--border)] bg-white/80 space-y-2">
            <div className="flex flex-wrap gap-1.5">
              {visibleCore.map((c) => (
                <button
                  key={c.label}
                  type="button"
                  className="chip"
                  disabled={scriptRunning}
                  onClick={() => submitFallback(c.text)}
                >
                  {c.label}
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                className="soft-input flex-1"
                placeholder={
                  isDental
                    ? 'Type as patient… appointment, toothache, hours…'
                    : settings.language === 'ar'
                      ? 'اكتب كضيف…'
                      : 'Type as guest… booking, spa, airport…'
                }
                value={fallbackInput}
                onChange={(e) => setFallbackInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submitFallback()}
                dir={settings.language === 'ar' ? 'rtl' : 'ltr'}
              />
              <button className="btn btn-ghost" onClick={() => submitFallback()} disabled={scriptRunning}>
                Send
              </button>
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <div className="panel p-5">
            <h2 className="font-display text-xl text-[var(--gold-soft)] mb-1">
              {isDental ? 'Appointment request' : 'Booking captured'}
            </h2>
            <p className="text-xs text-[var(--text-muted)] mb-4">
              {isDental
                ? 'Request sent to the practice team — not a live diary write'
                : 'Fields the desk needs for callback'}
            </p>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-3 text-sm">
              {isDental ? (
                <>
                  <Field label="Patient name" value={b.guestName} />
                  <Field label="Phone" value={b.phone} />
                  <Field label="New / existing" value={b.patientType || ''} />
                  <Field label="Practice" value={b.practice || ''} />
                  <Field label="Reason" value={b.reason || ''} />
                  <Field label="Preferred time" value={b.preferredDayTime || ''} />
                  <Field label="Emergency" value={b.isEmergency ? 'URGENT' : 'No'} />
                  <Field label="Language" value="English (UK)" />
                </>
              ) : (
                <>
                  <Field label="Guest name" value={b.guestName} />
                  <Field label="Phone" value={b.phone} />
                  <Field label="Check-in" value={b.checkIn} />
                  <Field label="Check-out" value={b.checkOut} />
                  <Field label="Rooms" value={b.rooms?.toString() ?? ''} />
                  <Field label="Adults / Children" value={formatGuests(b.adults, b.children)} />
                  <Field label="Language" value={b.language === 'ar' ? 'Arabic · العربية' : 'English'} />
                  <Field label="Special requests" value={b.specialRequests} wide />
                </>
              )}
            </dl>
            <div className="mt-4 pt-3 border-t border-[var(--border)] flex items-center justify-between gap-2">
              <span className="text-xs uppercase tracking-wider text-[var(--text-muted)]">Outcome</span>
              <span className="font-semibold text-[var(--gold)]">{outcomeLabel(session.outcome)}</span>
            </div>
          </div>

          <div className="panel p-5">
            <h2 className="font-display text-xl text-[var(--gold-soft)] mb-1">
              {isDental ? 'Practice notify' : 'Desk WhatsApp'}
            </h2>
            <p className="text-xs text-[var(--text-muted)] mb-3">
              {isDental
                ? 'Alert the practice team (not patient login)'
                : 'Alert the hotel number (not guest login)'}
            </p>
            {latestNotify ? (
              <div className="rounded-2xl overflow-hidden border border-[var(--border)]">
                <div className="bg-[var(--wa-green)] text-white px-3 py-2 text-xs flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2 min-w-0">
                    {isDental && (
                      <span className="w-6 h-6 rounded-full bg-white/20 flex items-center justify-center font-display text-[10px] shrink-0">
                        {(biz.logoText || 'MM').slice(0, 2)}
                      </span>
                    )}
                    <span className="truncate">
                      {isDental ? `${biz.name} · Practice desk` : 'Reservations desk'}
                    </span>
                  </span>
                  <span className="opacity-80 shrink-0">
                    {biz.deskDisplayPhone ||
                      biz.hotelExtras?.whatsappDesk ||
                      (isDental ? '020 7946 0123 (demo)' : 'demo desk')}
                  </span>
                </div>
                <div className="p-3 bg-[#ece5dd]">
                  <div className="bg-[var(--wa-bubble-out)] text-[#111b21] rounded-xl rounded-tr-sm px-3 py-2 text-sm ml-auto max-w-[95%] shadow-sm">
                    <div className="font-semibold text-[var(--gold)] text-xs mb-1">{latestNotify.subject}</div>
                    {latestNotify.body}
                    <div className="text-[10px] text-right opacity-70 mt-1">
                      {new Date(latestNotify.timestamp).toLocaleTimeString()}
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <p className="text-sm text-[var(--text-muted)]">Run the demo — the desk message appears here.</p>
            )}
            <div className="mt-3 flex flex-wrap gap-2 items-center">
              <input
                className="soft-input flex-1 min-w-[160px] text-sm"
                placeholder={isDental ? 'Practice WhatsApp 07…' : 'Desk WhatsApp +9715…'}
                value={deskWa}
                onChange={(e) => setDeskWa(e.target.value)}
                onBlur={() => saveDeskWhatsAppOverride(deskWa)}
              />
              <button
                type="button"
                className="btn btn-ghost text-xs"
                disabled={waBusy || scriptRunning}
                onClick={async () => {
                  saveDeskWhatsAppOverride(deskWa || '+923069607679')
                  await pushRealWhatsApp({
                    guestName: 'Ahmed Al Mansoori',
                    phone: '+971 50 555 5555',
                    checkIn: '2026-10-10',
                    checkOut: '2026-10-13',
                    adults: 2,
                    children: 1,
                    specialRequests: 'Demo: alert to desk WhatsApp',
                  })
                }}
              >
                {waBusy ? 'Sending…' : 'Test alert'}
              </button>
            </div>
            {waSend && (
              <p
                className={`text-xs mt-2 ${
                  waSend.ok
                    ? 'text-[var(--success)]'
                    : waSend.error === 'offline' || /offline|Failed to fetch|NetworkError|no provider/i.test(waSend.error || '')
                      ? 'text-[var(--text-muted)]'
                      : 'text-[var(--danger)]'
                }`}
              >
                {waSend.ok
                  ? `Sent · ${waSend.to}`
                  : waSend.error === 'offline' || /offline|Failed to fetch|NetworkError|no provider/i.test(waSend.error || '')
                    ? 'Demo mode · desk alert simulated'
                    : waSend.error}
              </p>
            )}
          </div>

          <div className="panel p-4 grid grid-cols-1 gap-3">
            <ToggleRow
              icon={<Languages size={16} />}
              label="Language"
              value={settings.language === 'ar' ? 'العربية' : 'English'}
              on={settings.language === 'ar'}
              onToggle={() => demo.setSettings({ language: settings.language === 'ar' ? 'en' : 'ar' })}
            />
            <ToggleRow
              icon={<Moon size={16} />}
              label="After-hours"
              value={settings.afterHours ? 'ON' : 'OFF'}
              on={settings.afterHours}
              onToggle={() => demo.setSettings({ afterHours: !settings.afterHours })}
            />
            <ToggleRow
              icon={<UserRound size={16} />}
              label="Human takeover"
              value={settings.humanTakeover ? 'ON' : 'OFF'}
              on={settings.humanTakeover}
              onToggle={() => demo.setSettings({ humanTakeover: !settings.humanTakeover })}
            />
          </div>
        </div>
      </div>

      {!isDental && (
        <details className="panel p-0 overflow-hidden group">
          <summary className="cursor-pointer list-none px-5 py-4 font-display text-lg text-[var(--gold-soft)] flex items-center justify-between">
            Cost &amp; difference vs other chatbots
            <span className="text-sm font-sans font-medium text-[var(--text-muted)] group-open:hidden">Show</span>
            <span className="text-sm font-sans font-medium text-[var(--text-muted)] hidden group-open:inline">Hide</span>
          </summary>
          <div className="px-2 pb-2">
            <CostDifferencePanel />
          </div>
        </details>
      )}

      <StaffQueuePanel
        tickets={tickets}
        onClaim={demo.claimTicket}
        onDone={demo.markTicketDone}
        labels={preset.staffQueueLabels}
        teamHint={
          isDental
            ? 'Ops view · in production this is the practice team inbox'
            : 'Ops view · in production this is the reservations team inbox'
        }
      />

      <details className="panel p-0 overflow-hidden">
        <summary className="cursor-pointer list-none px-5 py-4 font-display text-lg text-[var(--gold-soft)]">
          History &amp; tool log (for IT)
        </summary>
        <div className="grid lg:grid-cols-2 gap-4 px-5 pb-5">
          <div>
            <h3 className="text-sm font-semibold text-[var(--text-muted)] mb-2 flex items-center gap-2">
              <History size={16} /> Call history
            </h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[var(--text-muted)] border-b border-[var(--border)]">
                    <th className="py-2 font-medium">Time</th>
                    <th className="py-2 font-medium">{isDental ? 'Patient' : 'Guest'}</th>
                    <th className="py-2 font-medium">Outcome</th>
                  </tr>
                </thead>
                <tbody>
                  {history.length === 0 && (
                    <tr>
                      <td colSpan={3} className="py-3 text-[var(--text-muted)]">
                        No demo calls yet
                      </td>
                    </tr>
                  )}
                  {history.map((h) => (
                    <tr key={h.id} className="border-b border-[var(--border)]/60">
                      <td className="py-2 whitespace-nowrap">{new Date(h.timestamp).toLocaleString()}</td>
                      <td className="py-2">{h.guestName}</td>
                      <td className="py-2">{outcomeLabel(h.outcome)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-[var(--text-muted)] mb-2">Tool call log</h3>
            <div className="max-h-[220px] overflow-y-auto space-y-1.5 font-mono text-xs">
              {session.toolLogs.length === 0 && <div className="text-[var(--text-muted)]">No tool calls yet</div>}
              {[...session.toolLogs].reverse().map((l) => (
                <div key={l.id} className="border border-[var(--border)] rounded-xl px-2 py-1.5 bg-white">
                  <span className="text-[var(--gold)]">{l.tool}</span>
                  <span className="text-[var(--text-muted)]"> → {l.result}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </details>
    </div>
  )
}

function Field({ label, value, wide }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={wide ? 'col-span-2' : ''}>
      <dt className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{label}</dt>
      <dd className="text-[var(--text)] min-h-[1.25rem]">{value || '-'}</dd>
    </div>
  )
}

function StaffQueuePanel({
  tickets,
  onClaim,
  onDone,
  labels,
  teamHint,
}: {
  tickets: StaffTicket[]
  onClaim: (id: string) => void
  onDone: (id: string) => void
  labels: { title: string; claim: string; done: string; open: string; urgent: string }
  teamHint: string
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = tickets.find((t) => t.id === selectedId) ?? null
  const ordered = [...tickets].sort((a, b) => {
    const rank = (p: StaffTicket['priority']) => (p === 'urgent' ? 2 : p === 'high' ? 1 : 0)
    const d = rank(b.priority) - rank(a.priority)
    return d !== 0 ? d : b.timestamp - a.timestamp
  })

  return (
    <div className="panel p-4">
      <div className="flex flex-wrap items-start justify-between gap-2 mb-3">
        <div>
          <h2 className="font-display text-xl text-[var(--gold-soft)] flex items-center gap-2">
            <PhoneForwarded size={18} /> {labels.title}
          </h2>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">{teamHint}</p>
        </div>
        <span className="demo-badge">DEMO</span>
      </div>

      {ordered.length === 0 ? (
        <p className="text-sm text-[var(--text-muted)]">
          No tickets yet. Reservation inquiries, change requests, complaints, and human handoffs land here for claim /
          done.
        </p>
      ) : (
        <div className="grid lg:grid-cols-5 gap-3">
          <div className="lg:col-span-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[var(--text-muted)] border-b border-[var(--border)]">
                  <th className="py-2 font-medium">Time</th>
                  <th className="py-2 font-medium">Channel</th>
                  <th className="py-2 font-medium">{labels.title.includes('Practice') ? 'Patient' : 'Guest'}</th>
                  <th className="py-2 font-medium">Reason</th>
                  <th className="py-2 font-medium">Priority</th>
                  <th className="py-2 font-medium">Status</th>
                  <th className="py-2 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {ordered.map((t) => (
                  <tr
                    key={t.id}
                    className={`border-b border-[var(--border)]/60 cursor-pointer ${
                      selectedId === t.id ? 'bg-[rgba(201,162,39,0.08)]' : ''
                    }`}
                    onClick={() => setSelectedId(t.id)}
                  >
                    <td className="py-2 whitespace-nowrap text-xs">
                      {new Date(t.timestamp).toLocaleTimeString()}
                    </td>
                    <td className="py-2 capitalize text-xs">{t.channel}</td>
                    <td className="py-2">
                      <div>{t.guestName}</div>
                      <div className="text-xs text-[var(--text-muted)]">{t.phone}</div>
                    </td>
                    <td className="py-2 text-xs max-w-[180px] truncate" title={t.summary}>
                      {t.reason}
                    </td>
                    <td className="py-2">
                      <span
                        className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${
                          t.priority === 'urgent' || t.priority === 'high'
                            ? 'bg-[rgba(196,92,92,0.2)] text-[var(--danger)]'
                            : 'bg-[rgba(106,143,173,0.15)] text-[var(--info)]'
                        }`}
                      >
                        {t.priority === 'urgent' ? labels.urgent : t.priority}
                      </span>
                    </td>
                    <td className="py-2 capitalize text-xs">
                      {t.status}
                      {t.claimedBy ? ` · ${t.claimedBy}` : ''}
                    </td>
                    <td className="py-2">
                      <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
                        {t.status === 'open' && (
                          <button
                            type="button"
                            className="btn btn-light text-xs py-1"
                            onClick={() => onClaim(t.id)}
                          >
                            {labels.claim}
                          </button>
                        )}
                        {t.status !== 'done' && (
                          <button
                            type="button"
                            className="btn btn-light text-xs py-1"
                            onClick={() => onDone(t.id)}
                          >
                            {labels.done}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="lg:col-span-2 rounded-lg border border-[var(--border)] bg-[var(--bg)] p-3 text-sm min-h-[120px]">
            {selected ? (
              <>
                <div className="text-xs uppercase text-[var(--text-muted)] mb-1">Ticket detail</div>
                <div className="font-medium text-[var(--gold-soft)] mb-1">{selected.reason}</div>
                <p className="text-[var(--text-muted)] text-xs mb-2">{selected.summary}</p>
                {selected.notificationBody && (
                  <div className="text-xs border-t border-[var(--border)] pt-2 mt-2 whitespace-pre-wrap">
                    {selected.notificationBody}
                  </div>
                )}
              </>
            ) : (
              <p className="text-xs text-[var(--text-muted)]">Click a ticket to view summary / notify body.</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function formatGuests(adults: number | null, children: number | null) {
  if (adults === null && children === null) return ''
  return `${adults ?? '-'} / ${children ?? '-'}`
}

function ToggleRow({
  icon,
  label,
  value,
  on,
  onToggle,
}: {
  icon: ReactNode
  label: string
  value: string
  on: boolean
  onToggle: () => void
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-2 text-sm">
        <span className="text-[var(--gold)]">{icon}</span>
        <div>
          <div className="font-medium">{label}</div>
          <div className="text-xs text-[var(--text-muted)]">{value}</div>
        </div>
      </div>
      <button type="button" className={`toggle ${on ? 'on' : ''}`} onClick={onToggle} aria-label={label} />
    </div>
  )
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}
