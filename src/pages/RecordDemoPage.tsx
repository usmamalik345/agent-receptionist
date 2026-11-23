/**
 * Client-ready feature video for MM Dental Care.
 * Screen-record this page: call transcript + WhatsApp desk alert + practice queue.
 * Film mode hides chrome for a clean recording.
 */

import { useEffect, useRef, useState } from 'react'
import { useBusiness } from '../store/BusinessContext'
import { useDemo } from '../store/DemoContext'
import { setActiveBusiness } from '../lib/businessRuntime'
import { speakText, stopSpeaking, warmupTts } from '../lib/speech'
import type { DeskNotification, StaffTicket } from '../lib/types'

type ChapterId =
  | 'idle'
  | 'emergency'
  | 'membership'
  | 'hours'
  | 'reschedule'
  | 'afterhours'
  | 'done'

const CHAPTERS: { id: ChapterId; label: string; blurb: string }[] = [
  { id: 'emergency', label: '1 · Same-day emergency', blurb: 'Toothache → fee → URGENT ticket + WhatsApp' },
  { id: 'membership', label: '2 · Membership & fees', blurb: 'Only verified prices from config' },
  { id: 'hours', label: '3 · Saturday hours', blurb: 'Both practices — correct diary times' },
  { id: 'reschedule', label: '4 · Move appointment', blurb: 'Callback only — no live diary change' },
  { id: 'afterhours', label: '5 · After-hours emergency', blurb: 'Closed → URGENT callback at opening' },
  { id: 'done', label: 'Complete', blurb: 'Ready for your practice line' },
]

export function RecordDemoPage() {
  const { biz } = useBusiness()
  const demo = useDemo()
  const [running, setRunning] = useState(false)
  const [film, setFilm] = useState(false)
  const [chapter, setChapter] = useState<ChapterId>('idle')
  const [chapterBanner, setChapterBanner] = useState('')
  const abort = useRef(false)
  const bottom = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setActiveBusiness(biz)
    return () => {
      abort.current = true
      stopSpeaking()
      document.body.classList.remove('film-mode')
    }
  }, [biz])

  useEffect(() => {
    if (film) document.body.classList.add('film-mode')
    else document.body.classList.remove('film-mode')
  }, [film])

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth' })
  }, [demo.session.transcript.length, demo.notifications.length, demo.tickets.length, chapter])

  // Bridge for automated client-video recording (Playwright + edge-tts)
  useEffect(() => {
    const w = window as unknown as {
      __mmDentalDrive?: {
        reset: () => void
        setAfterHours: (on: boolean) => void
        start: () => void
        greet: () => string
        send: (text: string) => string
        setFilm: (on: boolean) => void
        setChapter: (id: string, banner: string) => void
        tickets: () => number
        notifies: () => number
      }
    }
    w.__mmDentalDrive = {
      reset: () => demo.resetDemo(),
      setAfterHours: (on) => demo.setSettings({ afterHours: on, language: 'en', humanTakeover: false }),
      start: () => demo.startSession('voice'),
      greet: () => demo.runGreeting(),
      send: (text) => demo.sendGuestMessage(text),
      setFilm: (on) => {
        setFilm(on)
        if (on) document.body.classList.add('film-mode')
        else document.body.classList.remove('film-mode')
      },
      setChapter: (id, banner) => {
        setChapter(id as ChapterId)
        setChapterBanner(banner)
      },
      tickets: () => demo.tickets.length,
      notifies: () => demo.notifications.length,
    }
    return () => {
      delete w.__mmDentalDrive
    }
  }, [demo])

  if (biz.slug !== 'mm-dental') {
    return (
      <div className="panel p-8 max-w-lg mx-auto text-center">
        <h1 className="font-display text-2xl" style={{ color: 'var(--gold-soft)' }}>
          Client video
        </h1>
        <p className="text-sm text-[var(--text-muted)] mt-2">
          Open with <code>?biz=mm-dental</code>.
        </p>
        <a className="btn btn-primary mt-4 inline-flex" href="/record-demo?biz=mm-dental">
          Open MM Dental Care client video
        </a>
      </div>
    )
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  const sayAi = async (text: string) => {
    if (!text || abort.current) return
    await speakText(text, 'en', { voiceLocale: biz.voiceLocale, skipCancel: true })
  }

  const announce = async (id: ChapterId) => {
    const c = CHAPTERS.find((x) => x.id === id)
    setChapter(id)
    setChapterBanner(c ? `${c.label} — ${c.blurb}` : '')
    await sleep(900)
  }

  const turn = async (patientText: string) => {
    if (abort.current) return ''
    const reply = demo.sendGuestMessage(patientText)
    await sayAi(reply)
    await sleep(450)
    return reply
  }

  const confirmIfNeeded = async (prevReply: string) => {
    if (abort.current) return
    if (/shall i send|just to confirm|confirm —/i.test(prevReply)) {
      await turn('Yes please')
    }
  }

  const runShow = async () => {
    abort.current = false
    setRunning(true)
    setFilm(true)
    setActiveBusiness('mm-dental')
    warmupTts()
    demo.resetDemo()
    demo.setSettings({ afterHours: false, language: 'en', humanTakeover: false })

    // —— 1. Same-day emergency ——
    await announce('emergency')
    demo.startSession('voice')
    const greet = demo.runGreeting()
    await sayAi(greet)
    await sleep(400)
    let reply = await turn(
      "Hi, I've got really bad toothache, can I get seen today? Uppingham Road. Name James Patel, phone 07700 900123, new patient.",
    )
    await confirmIfNeeded(reply)
    await sleep(1200)

    // —— 2. Membership ——
    await announce('membership')
    demo.startSession('voice')
    demo.runGreeting()
    reply = await turn('Do you do membership plans?')
    await sleep(800)
    reply = await turn('How much is an emergency appointment?')
    await sleep(1000)

    // —— 3. Saturday hours ——
    await announce('hours')
    reply = await turn('What time are you open on Saturday?')
    await sleep(1200)

    // —— 4. Reschedule ——
    await announce('reschedule')
    reply = await turn(
      'I need to move my appointment on Thursday. Name Alex Reed, phone 07700 900999',
    )
    await sleep(1200)

    // —— 5. After-hours emergency (keep prior tickets — fresh call only) ——
    await announce('afterhours')
    demo.setSettings({ afterHours: true, language: 'en', humanTakeover: false })
    demo.startSession('voice')
    const nightGreet = demo.runGreeting()
    await sayAi(nightGreet)
    await sleep(350)
    reply = await turn(
      "It's 9pm — my filling fell out and it's killing me. Name Sarah Khan, phone 07700 900456, existing patient, Uppingham Road.",
    )
    await confirmIfNeeded(reply)
    await sleep(1000)

    setChapter('done')
    setChapterBanner('Demo complete — AI receptionist for MM Dental Care')
    setRunning(false)
  }

  const stop = () => {
    abort.current = true
    stopSpeaking()
    setRunning(false)
    setFilm(false)
    setChapter('idle')
    setChapterBanner('')
  }

  const latestNotify = demo.notifications[0] as DeskNotification | undefined
  const tickets = [...demo.tickets].sort((a, b) => b.timestamp - a.timestamp)
  const transcript = demo.session.transcript
  const practicePhone = biz.deskDisplayPhone || '020 7946 0123 (demo)'

  return (
    <div className={`mx-auto space-y-4 ${film ? 'max-w-[1180px]' : 'max-w-[1180px]'}`}>
      {/* Controls — hidden in film mode after start */}
      {!film && (
        <div className="flex flex-wrap items-end justify-between gap-3 panel p-5">
          <div>
            <p className="text-xs uppercase tracking-[0.16em] text-[var(--text-muted)]">
              Client video · screen-record this page
            </p>
            <h1 className="font-display text-3xl md:text-4xl mt-1" style={{ color: biz.brandColor }}>
              {biz.name}
            </h1>
            <p className="text-sm text-[var(--text-muted)] mt-1 max-w-xl">
              Full feature walkthrough: emergency, fees, hours, reschedule, after-hours — with live WhatsApp desk
              alert and practice queue on screen.
            </p>
            <ol className="mt-3 text-xs text-[var(--text-muted)] space-y-1 list-decimal pl-4">
              <li>Click <strong className="text-[var(--text)]">Play client video</strong> (allow sound).</li>
              <li>Start Windows/Mac screen recording on this browser tab only.</li>
              <li>Wait until “Demo complete” — then stop recording and send to the client.</li>
            </ol>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              className="btn btn-primary text-base px-5 py-3"
              disabled={running}
              onPointerDown={() => warmupTts()}
              onClick={() => void runShow()}
            >
              Play client video
            </button>
            <button className="btn btn-secondary" onClick={() => demo.resetDemo()} disabled={running}>
              Reset
            </button>
          </div>
        </div>
      )}

      {film && (
        <div className="flex items-center justify-between gap-3 px-1">
          <div className="flex items-center gap-3 min-w-0">
            <div
              className="w-10 h-10 rounded-xl text-white flex items-center justify-center font-display shrink-0"
              style={{ background: biz.brandColor }}
            >
              {biz.logoText.slice(0, 2)}
            </div>
            <div className="min-w-0">
              <div className="font-display text-xl truncate" style={{ color: biz.brandColor }}>
                {biz.name}
              </div>
              <div className="text-[11px] text-[var(--text-muted)]">AI receptionist · Leicester practices</div>
            </div>
          </div>
          {running ? (
            <button className="btn btn-secondary text-xs" onClick={stop}>
              Stop
            </button>
          ) : (
            <button className="btn btn-secondary text-xs" onClick={() => setFilm(false)}>
              Exit film mode
            </button>
          )}
        </div>
      )}

      {/* Chapter banner */}
      {chapterBanner && (
        <div
          className="rounded-2xl px-5 py-3 text-white font-medium shadow-[var(--shadow-soft)] animate-fade-up"
          style={{ background: biz.brandColor }}
        >
          {chapterBanner}
        </div>
      )}

      {/* Feature progress */}
      <div className="flex flex-wrap gap-1.5">
        {CHAPTERS.filter((c) => c.id !== 'done').map((c) => {
          const active = chapter === c.id
          const doneIdx = CHAPTERS.findIndex((x) => x.id === chapter)
          const thisIdx = CHAPTERS.findIndex((x) => x.id === c.id)
          const passed = doneIdx > thisIdx || chapter === 'done'
          return (
            <span
              key={c.id}
              className={`text-[10px] uppercase tracking-wide px-2.5 py-1 rounded-full border ${
                active
                  ? 'bg-[var(--stage)] text-[var(--stage-text)] border-transparent'
                  : passed
                    ? 'border-[rgba(15,118,110,0.4)] text-[var(--gold-soft)]'
                    : 'border-[var(--border)] text-[var(--text-muted)]'
              }`}
            >
              {c.label}
            </span>
          )
        })}
      </div>

      {/* Main stage: call | WhatsApp | queue */}
      <div className="grid lg:grid-cols-[1.15fr_0.95fr] gap-4">
        {/* Call transcript */}
        <div className="panel p-0 overflow-hidden flex flex-col min-h-[420px]">
          <div className="px-4 py-3 border-b border-[var(--border)] flex items-center justify-between bg-white/70">
            <div>
              <div className="font-display text-lg" style={{ color: biz.brandColor }}>
                Live call
              </div>
              <div className="text-[11px] text-[var(--text-muted)]">
                {demo.settings.afterHours ? 'After-hours · practice closed' : 'In hours · same-day possible'}
              </div>
            </div>
            <span className="demo-badge">DEMO</span>
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-3 max-h-[520px] bg-[rgba(247,249,251,0.6)]">
            {transcript.length === 0 && (
              <p className="text-sm text-[var(--text-muted)] text-center py-16">
                Press Play client video — conversation appears here.
              </p>
            )}
            {transcript.map((t) => (
              <div key={t.id} className={`flex ${t.speaker === 'Guest' ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[88%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed shadow-sm ${
                    t.speaker === 'Guest'
                      ? 'bg-[var(--accent-soft)] text-[var(--text)]'
                      : 'bg-[var(--stage)] text-[var(--stage-text)]'
                  }`}
                >
                  <div className="text-[10px] uppercase tracking-wide opacity-70 mb-0.5">
                    {t.speaker === 'Guest' ? 'Caller' : 'AI'}
                  </div>
                  {t.text}
                </div>
              </div>
            ))}
            <div ref={bottom} />
          </div>
        </div>

        <div className="space-y-4">
          {/* WhatsApp desk alert — prominent for client video */}
          <WhatsAppDeskCard
            brandColor={biz.brandColor}
            practicePhone={practicePhone}
            practiceName={biz.name}
            logoText={biz.logoText}
            notify={latestNotify}
          />

          {/* Practice queue */}
          <PracticeQueueCard tickets={tickets} brandColor={biz.brandColor} />
        </div>
      </div>

      {chapter === 'done' && !running && (
        <div className="panel p-6 text-center space-y-2 animate-fade-up">
          <p className="font-display text-2xl" style={{ color: biz.brandColor }}>
            Ready for {biz.name}
          </p>
          <p className="text-sm text-[var(--text-muted)] max-w-lg mx-auto">
            Overflow & after-hours answered · appointment requests to the practice team · WhatsApp desk alert ·
            URGENT emergencies · Claim / Done queue — no invented prices or live diary writes.
          </p>
        </div>
      )}
    </div>
  )
}

function WhatsAppDeskCard({
  brandColor,
  practicePhone,
  practiceName,
  logoText,
  notify,
}: {
  brandColor: string
  practicePhone: string
  practiceName: string
  logoText: string
  notify?: DeskNotification
}) {
  const initials = (logoText || practiceName || 'MM').slice(0, 2).toUpperCase()
  return (
    <div className="rounded-2xl overflow-hidden border border-[var(--border)] shadow-[var(--shadow-soft)] bg-white">
      <div className="bg-[var(--wa-green)] text-white px-4 py-3 flex items-center gap-3">
        <div className="w-10 h-10 rounded-full bg-white/20 flex items-center justify-center font-display text-sm">
          {initials}
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm truncate">{practiceName} · Practice desk</div>
          <div className="text-[11px] opacity-90">WhatsApp Business alert · {practicePhone}</div>
        </div>
        {notify && (
          <span className="text-[10px] uppercase tracking-wide bg-white/20 px-2 py-1 rounded-full">New</span>
        )}
      </div>
      <div
        className="p-4 min-h-[200px]"
        style={{
          backgroundColor: '#ece5dd',
          backgroundImage:
            'url("data:image/svg+xml,%3Csvg width=\"60\" height=\"60\" xmlns=\"http://www.w3.org/2000/svg\"%3E%3Cpath d=\"M0 0h60v60H0z\" fill=\"%23ece5dd\"/%3E%3C/svg%3E")',
        }}
      >
        {!notify ? (
          <div className="text-center text-sm text-[var(--text-muted)] py-10 bg-white/80 rounded-xl border border-[var(--border)]">
            Desk WhatsApp message will appear here when a request is logged.
          </div>
        ) : (
          <div className="animate-fade-up">
            <div className="text-center mb-3">
              <span className="inline-block bg-white/90 text-[10px] text-[var(--text-muted)] px-3 py-1 rounded-md">
                Today · practice team inbox
              </span>
            </div>
            <div className="bg-[var(--wa-bubble-out)] text-[#111b21] rounded-xl rounded-tr-sm px-3.5 py-3 text-sm shadow-sm max-w-[100%] ml-auto border border-black/5">
              <div className="font-semibold text-xs mb-1.5" style={{ color: brandColor }}>
                {notify.subject}
              </div>
              <p className="leading-relaxed whitespace-pre-wrap">{notify.body}</p>
              <div className="flex items-center justify-end gap-1 mt-2 text-[10px] text-[#667781]">
                <span>{new Date(notify.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                <span className="text-[var(--wa-green)]" aria-hidden>
                  ✓✓
                </span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function PracticeQueueCard({ tickets, brandColor }: { tickets: StaffTicket[]; brandColor: string }) {
  return (
    <div className="panel p-4">
      <div className="flex items-center justify-between gap-2 mb-3">
        <h2 className="font-display text-lg" style={{ color: brandColor }}>
          Practice queue
        </h2>
        <span className="text-[10px] uppercase text-[var(--text-muted)]">{tickets.length} ticket(s)</span>
      </div>
      {tickets.length === 0 ? (
        <p className="text-sm text-[var(--text-muted)] py-6 text-center">Tickets appear when AI logs a request.</p>
      ) : (
        <ul className="space-y-2 max-h-[280px] overflow-y-auto">
          {tickets.map((t) => (
            <li
              key={t.id}
              className="rounded-xl border border-[var(--border)] p-3 bg-white animate-fade-up"
              style={
                t.priority === 'urgent'
                  ? { borderColor: 'rgba(180,35,24,0.45)', boxShadow: '0 0 0 1px rgba(180,35,24,0.12)' }
                  : undefined
              }
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-medium text-sm truncate">{t.reason}</div>
                  <div className="text-xs text-[var(--text-muted)] mt-0.5">{t.summary}</div>
                  <div className="text-[11px] text-[var(--text-muted)] mt-1">
                    {t.guestName} · {t.phone}
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1 shrink-0">
                  <span
                    className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${
                      t.priority === 'urgent' || t.priority === 'high'
                        ? 'bg-[rgba(196,92,92,0.2)] text-[var(--danger)]'
                        : 'bg-[rgba(106,143,173,0.15)] text-[var(--info)]'
                    }`}
                  >
                    {t.priority === 'urgent' ? 'URGENT' : t.priority}
                  </span>
                  <div className="flex gap-1">
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--accent-wash)] text-[var(--gold-soft)]">
                      Claim
                    </span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--accent-wash)] text-[var(--gold-soft)]">
                      Done
                    </span>
                  </div>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
