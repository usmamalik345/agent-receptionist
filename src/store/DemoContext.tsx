import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { greet, processGuestMessage } from '../lib/stateMachine'
import { recordEngineTurn } from '../lib/turnTelemetry'
import {
  bookingPrefillFromProfile,
  findGuestProfile,
  upsertGuestProfile,
  welcomeBackLine,
} from '../lib/guestMemory'
import {
  createEmptySession,
  defaultStore,
  getDemoStorageKey,
  loadStore,
  MAX_OVERFLOW_LINES,
  OVERFLOW_DEMO_GUESTS,
  resetStore,
  saveStore,
  syncActiveSession,
} from '../lib/storage'
import type {
  AuditEvent,
  CallRecord,
  Channel,
  DemoSettings,
  DemoStoreData,
  Language,
  Speaker,
  StaffTicket,
  TranscriptEntry,
  ToolLog,
} from '../lib/types'
import { normalizeTicket } from '../lib/types'

interface DemoContextValue extends DemoStoreData {
  appendTranscript: (speaker: Speaker, text: string) => void
  setSettings: (patch: Partial<DemoSettings>) => void
  startSession: (channel: Channel) => void
  setStatus: (status: DemoStoreData['session']['status']) => void
  sendGuestMessage: (text: string) => string
  runGreeting: () => string
  applyScriptedTurn: (speaker: Speaker, text: string, bookingPatch?: Partial<DemoStoreData['session']['booking']>) => void
  finalizeScriptedBooking: () => void
  escalateNow: (reason?: string) => void
  resetDemo: () => void
  markNotificationRead: (id: string) => void
  claimTicket: (id: string, agentName?: string) => void
  markTicketDone: (id: string) => void
  pushAudit: (actor: AuditEvent['actor'], action: string, detail: string) => void
  recallGuestByPhone: (phone: string) => string | null
  switchSession: (id: string) => void
  spawnOverflowLine: () => string | null
  closeSessionLine: (id: string) => void
}

const DemoContext = createContext<DemoContextValue | null>(null)

function pushLog(logs: ToolLog[], tool: string, args: Record<string, unknown>, result: string): ToolLog[] {
  return [
    ...logs,
    {
      id: crypto.randomUUID(),
      tool,
      args,
      result,
      timestamp: Date.now(),
    },
  ].slice(-40)
}

function appendAudit(
  log: AuditEvent[],
  actor: AuditEvent['actor'],
  action: string,
  detail: string,
  sessionId?: string,
): AuditEvent[] {
  return [
    {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      actor,
      action,
      detail,
      sessionId,
    },
    ...log,
  ].slice(0, 200)
}

export function DemoProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<DemoStoreData>(() =>
    typeof window !== 'undefined' ? loadStore() : defaultStore(),
  )

  useEffect(() => {
    saveStore(data)
  }, [data])

  // Cross-tab sync so WhatsApp window updates the screen-shared dashboard
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== getDemoStorageKey() || !e.newValue) return
      try {
        setData(JSON.parse(e.newValue) as DemoStoreData)
      } catch {
        /* ignore */
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const setSettings = useCallback((patch: Partial<DemoSettings>) => {
    setData((prev) => {
      let auditLog = prev.auditLog
      if (patch.aiPaused !== undefined && patch.aiPaused !== prev.settings.aiPaused) {
        auditLog = appendAudit(
          auditLog,
          'it',
          patch.aiPaused ? 'kill_switch_on' : 'kill_switch_off',
          patch.aiPaused ? 'AI paused — guests queued to staff' : 'AI resumed',
          prev.session.id,
        )
      }
      if (patch.operaWriteUnlocked !== undefined && patch.operaWriteUnlocked !== prev.settings.operaWriteUnlocked) {
        auditLog = appendAudit(
          auditLog,
          'it',
          patch.operaWriteUnlocked ? 'opera_write_unlocked' : 'opera_write_locked',
          patch.operaWriteUnlocked
            ? 'Opera write gate opened (DEMO — still no live PMS)'
            : 'Opera write gate locked',
          prev.session.id,
        )
      }
      if (patch.operaReadEnabled !== undefined && patch.operaReadEnabled !== prev.settings.operaReadEnabled) {
        auditLog = appendAudit(
          auditLog,
          'it',
          patch.operaReadEnabled ? 'opera_read_on' : 'opera_read_off',
          patch.operaReadEnabled ? 'Sandbox availability read enabled' : 'Availability read disabled',
          prev.session.id,
        )
      }
      return {
        ...prev,
        auditLog,
        settings: { ...prev.settings, ...patch },
        session: {
          ...prev.session,
          booking: {
            ...prev.session.booking,
            language: patch.language ?? prev.session.booking.language,
          },
        },
      }
    })
  }, [])

  const pushAudit = useCallback((actor: AuditEvent['actor'], action: string, detail: string) => {
    setData((prev) => ({
      ...prev,
      auditLog: appendAudit(prev.auditLog, actor, action, detail, prev.session.id),
    }))
  }, [])

  const recallGuestByPhone = useCallback((phone: string): string | null => {
    let line: string | null = null
    setData((prev) => {
      const profile = findGuestProfile(prev.guestProfiles, phone)
      if (!profile) return prev
      const lang = prev.settings.language
      line = welcomeBackLine(profile, lang)
      const prefill = bookingPrefillFromProfile(profile)
      return syncActiveSession(
        {
          ...prev,
          auditLog: appendAudit(
            prev.auditLog,
            'system',
            'guest_memory_hit',
            `Returning guest ${profile.guestName} · visits ${profile.visitCount}`,
            prev.session.id,
          ),
        },
        {
          ...prev.session,
          booking: { ...prev.session.booking, ...prefill },
          transcript: [
            ...prev.session.transcript,
            {
              id: crypto.randomUUID(),
              speaker: 'AI' as const,
              text: line!,
              timestamp: Date.now(),
            },
          ],
          toolLogs: pushLog(
            prev.session.toolLogs,
            'guest_memory_lookup',
            { phone, guestName: profile.guestName },
            'Returning guest recognized',
          ),
        },
      )
    })
    return line
  }, [])

  const startSession = useCallback((channel: Channel) => {
    setData((prev) => {
      const line = prev.session.line || 1
      const session = createEmptySession(prev.settings.language, line)
      session.channel = channel
      session.status = 'ringing'
      session.startedAt = Date.now()
      session.step = 'idle'
      // Replace active line with fresh call; keep other parallel lines
      const others = prev.sessions.filter((s) => s.id !== prev.activeSessionId)
      return syncActiveSession({ ...prev, sessions: [...others, session] }, session)
    })
  }, [])

  const setStatus = useCallback((status: DemoStoreData['session']['status']) => {
    setData((prev) => syncActiveSession(prev, { ...prev.session, status }))
  }, [])

  const appendTranscript = useCallback((speaker: Speaker, text: string) => {
    const entry: TranscriptEntry = {
      id: crypto.randomUUID(),
      speaker,
      text,
      timestamp: Date.now(),
    }
    setData((prev) =>
      syncActiveSession(prev, {
        ...prev.session,
        transcript: [...prev.session.transcript, entry],
      }),
    )
  }, [])

  const archiveIfEnded = useCallback(
    (
      prev: DemoStoreData,
      session: DemoStoreData['session'],
      outcome: DemoStoreData['session']['outcome'],
      summary: string,
    ): DemoStoreData => {
      if (!outcome) return syncActiveSession(prev, session)
      const record: CallRecord = {
        id: session.id,
        timestamp: Date.now(),
        channel: session.channel,
        outcome,
        guestName: session.booking.guestName || 'Guest',
        summary,
        booking: session.booking,
      }
      return syncActiveSession(
        {
          ...prev,
          history: [record, ...prev.history].slice(0, 30),
        },
        { ...session, outcome, status: 'completed', endedAt: Date.now() },
      )
    },
    [],
  )

  const switchSession = useCallback((id: string) => {
    setData((prev) => {
      const next = prev.sessions.find((s) => s.id === id)
      if (!next) return prev
      return {
        ...prev,
        session: next,
        activeSessionId: next.id,
        auditLog: appendAudit(prev.auditLog, 'ops', 'switch_line', `Switched to Line ${next.line}`, next.id),
      }
    })
  }, [])

  const spawnOverflowLine = useCallback((): string | null => {
    let note: string | null = null
    setData((prev) => {
      if (prev.sessions.length >= MAX_OVERFLOW_LINES) {
        note = `Max ${MAX_OVERFLOW_LINES} lines — close a completed line first`
        return prev
      }
      const used = new Set(prev.sessions.map((s) => s.line))
      let line = 1
      while (used.has(line) && line <= MAX_OVERFLOW_LINES) line++
      const guest = OVERFLOW_DEMO_GUESTS[(prev.sessions.length - 1) % OVERFLOW_DEMO_GUESTS.length]
      const session = createEmptySession(prev.settings.language, line)
      session.channel = 'voice'
      session.status = 'in_call'
      session.step = 'await_intent'
      session.startedAt = Date.now()
      session.booking = {
        ...session.booking,
        guestName: guest.guestName,
        phone: guest.phone,
        checkIn: guest.checkIn,
        checkOut: guest.checkOut,
        adults: guest.adults,
        children: guest.children,
        rooms: guest.adults >= 4 ? 2 : 1,
        specialRequests: guest.special,
        language: prev.settings.language,
      }
      session.transcript = [
        {
          id: crypto.randomUUID(),
          speaker: 'Guest',
          text: guest.opener,
          timestamp: Date.now(),
        },
        {
          id: crypto.randomUUID(),
          speaker: 'AI',
          text:
            prev.settings.language === 'ar'
              ? `خط ${line}: مرحباً ${guest.guestName}. سجّلت طلبكم — الحجوزات ستتصل بكم.`
              : `Line ${line}: Thanks ${guest.guestName}. I’ve logged your request — reservations will call back.`,
          timestamp: Date.now() + 1,
        },
      ]
      session.toolLogs = pushLog(
        [],
        'overflow_spawn',
        { line, guest: guest.guestName },
        'Parallel overflow line opened',
      )
      session.outcome = /AC|broken|complaint/i.test(guest.opener)
        ? 'callback_requested'
        : /Booking\.com|change|modify/i.test(guest.opener)
          ? 'callback_requested'
          : 'after_hours_saved'
      if (session.outcome === 'after_hours_saved' || session.outcome === 'callback_requested') {
        session.step = 'completed'
        session.status = 'completed'
        session.endedAt = Date.now()
      }

      const ticket: StaffTicket = normalizeTicket({
        id: crypto.randomUUID(),
        reason: `Overflow Line ${line} · ${guest.guestName}`,
        summary: guest.opener,
        guestName: guest.guestName,
        phone: guest.phone,
        timestamp: Date.now(),
        status: 'open',
        priority: /AC|broken/i.test(guest.opener) ? 'high' : 'normal',
        channel: 'voice',
        notificationBody: `Line ${line} · ${guest.guestName} · ${guest.checkIn}→${guest.checkOut} · ${guest.special}`,
      })

      const notification = {
        id: crypto.randomUUID(),
        channel: 'whatsapp' as const,
        subject: `Overflow Line ${line} · ${guest.guestName}`,
        body: `Parallel call captured. ${guest.guestName}, ${guest.adults} adults, ${guest.checkIn} to ${guest.checkOut}. ${guest.special}. Call back to confirm.`,
        timestamp: Date.now(),
        read: false,
      }

      note = `Line ${line} live · ${guest.guestName}`
      const sessions = [...prev.sessions, session]
      return {
        ...syncActiveSession({ ...prev, sessions }, session),
        tickets: [ticket, ...prev.tickets],
        notifications: [notification, ...prev.notifications],
        auditLog: appendAudit(
          prev.auditLog,
          'ops',
          'spawn_overflow_line',
          `Opened Line ${line} for ${guest.guestName}`,
          session.id,
        ),
        history:
          session.outcome
            ? [
                {
                  id: session.id,
                  timestamp: Date.now(),
                  channel: session.channel,
                  outcome: session.outcome,
                  guestName: guest.guestName,
                  summary: notification.body,
                  booking: session.booking,
                },
                ...prev.history,
              ].slice(0, 30)
            : prev.history,
      }
    })
    return note
  }, [])

  const closeSessionLine = useCallback((id: string) => {
    setData((prev) => {
      if (prev.sessions.length <= 1) return prev
      const sessions = prev.sessions.filter((s) => s.id !== id)
      const next = sessions[0]
      return {
        ...prev,
        sessions,
        session: next,
        activeSessionId: next.id,
        auditLog: appendAudit(prev.auditLog, 'ops', 'close_line', `Closed line ${id.slice(0, 8)}`, next.id),
      }
    })
  }, [])

  const runGreeting = useCallback((): string => {
    let replyText = ''
    setData((prev) => {
      const reply = greet(prev.settings.language, prev.settings.afterHours)
      replyText = reply.text
      const entry: TranscriptEntry = {
        id: crypto.randomUUID(),
        speaker: 'AI',
        text: reply.text,
        timestamp: Date.now(),
      }
      let logs = prev.session.toolLogs
      for (const tc of reply.toolCalls) {
        logs = pushLog(logs, tc.tool, tc.args, tc.result)
      }
      return syncActiveSession(prev, {
        ...prev.session,
        status: 'in_call',
        step: reply.nextStep,
        booking: { ...prev.session.booking, ...reply.bookingUpdates, language: prev.settings.language },
        transcript: [...prev.session.transcript, entry],
        toolLogs: logs,
        startedAt: prev.session.startedAt ?? Date.now(),
      })
    })
    return replyText
  }, [])

  const sendGuestMessage = useCallback((text: string): string => {
    let aiText = ''
    // Per-turn telemetry (no-op unless VITE_TRACE=1); recorded after setData so StrictMode double-runs don't double-log
    const telemetry: { turn: Parameters<typeof recordEngineTurn>[0] | null } = { turn: null }
    setData((prev) => {
      const guestEntry: TranscriptEntry = {
        id: crypto.randomUUID(),
        speaker: 'Guest',
        text,
        timestamp: Date.now(),
      }

      // IT kill switch — do not run the AI brain
      if (prev.settings.aiPaused) {
        aiText =
          prev.settings.language === 'ar'
            ? 'تم إيقاف المساعد الذكي مؤقتاً من قِبل تقنية المعلومات. سيتم تحويلكم إلى زميل في الحجوزات.'
            : 'Our AI assistant is temporarily paused by IT operations. I’m connecting you to a reservations colleague.'
        const aiEntry: TranscriptEntry = {
          id: crypto.randomUUID(),
          speaker: 'AI',
          text: aiText,
          timestamp: Date.now() + 1,
        }
        const ticket: StaffTicket = normalizeTicket({
          id: crypto.randomUUID(),
          reason: 'AI paused — overflow to desk',
          summary: text.slice(0, 160),
          guestName: prev.session.booking.guestName || 'Guest',
          phone: prev.session.booking.phone || '-',
          timestamp: Date.now(),
          status: 'open',
          priority: 'high',
          channel: prev.session.channel,
        })
        return syncActiveSession(
          {
            ...prev,
            tickets: [ticket, ...prev.tickets],
            auditLog: appendAudit(
              prev.auditLog,
              'ops',
              'ai_paused_queue',
              `Guest message queued while kill switch ON: ${text.slice(0, 80)}`,
              prev.session.id,
            ),
          },
          {
            ...prev.session,
            status: 'completed',
            step: 'escalated',
            outcome: 'transferred',
            transcript: [...prev.session.transcript, guestEntry, aiEntry],
            toolLogs: pushLog(
              prev.session.toolLogs,
              'kill_switch',
              { paused: true },
              'Queued to staff — AI offline',
            ),
            endedAt: Date.now(),
          },
        )
      }

      const stepBefore = prev.session.step === 'idle' ? 'await_intent' : prev.session.step
      const engineStart = performance.now()
      const reply = processGuestMessage({
        text,
        step: stepBefore,
        booking: prev.session.booking,
        language: prev.settings.language,
        afterHours: prev.settings.afterHours,
        humanTakeover: prev.settings.humanTakeover,
        operaReadEnabled: prev.settings.operaReadEnabled,
      })
      telemetry.turn = {
        callId: prev.session.id,
        channel: prev.session.channel,
        text,
        stepBefore,
        bookingBefore: prev.session.booking,
        engineStart,
        engineEnd: performance.now(),
        reply,
      }

      let booking = { ...prev.session.booking, ...reply.bookingUpdates }
      let replyText = reply.text
      let logs = prev.session.toolLogs
      for (const tc of reply.toolCalls) {
        logs = pushLog(logs, tc.tool, tc.args, tc.result)
      }

      // Returning guest: phone just captured → welcome back + soft prefill
      const phoneJustSet =
        reply.bookingUpdates.phone &&
        reply.bookingUpdates.phone !== prev.session.booking.phone
      if (phoneJustSet) {
        const profile = findGuestProfile(prev.guestProfiles, reply.bookingUpdates.phone!)
        if (profile && profile.guestName) {
          const wb = welcomeBackLine(profile, booking.language || prev.settings.language)
          replyText = `${wb} ${replyText}`
          booking = {
            ...booking,
            guestName: booking.guestName || profile.guestName,
            roomCategory: booking.roomCategory || profile.roomCategory,
            specialRequests: booking.specialRequests || profile.lastSpecial,
          }
          logs = pushLog(
            logs,
            'guest_memory_lookup',
            { phone: profile.phoneDigits, visits: profile.visitCount },
            'Returning guest recognized',
          )
        }
      }

      // Opera write still locked — stamp audit if finalize tries notify
      if (reply.createNotification && !prev.settings.operaWriteUnlocked) {
        logs = pushLog(
          logs,
          'opera_write_gate',
          { unlocked: false },
          'Inquiry to desk only — Opera write LOCKED',
        )
      }

      aiText = replyText

      const aiEntry: TranscriptEntry = {
        id: crypto.randomUUID(),
        speaker: 'AI',
        text: replyText,
        timestamp: Date.now() + 1,
      }

      let notifications = prev.notifications
      if (reply.createNotification) {
        notifications = [
          {
            id: crypto.randomUUID(),
            channel: 'whatsapp',
            subject: reply.createNotification.subject,
            body: reply.createNotification.body,
            timestamp: Date.now(),
            read: false,
          },
          ...notifications,
        ]
      }

      let tickets = prev.tickets
      const notifBody = reply.createNotification?.body
      if (reply.createTicket) {
        const ticket: StaffTicket = normalizeTicket({
          id: crypto.randomUUID(),
          reason: reply.createTicket.reason,
          summary: reply.createTicket.summary,
          guestName: booking.guestName || 'Guest',
          phone: booking.phone || '-',
          timestamp: Date.now(),
          status: 'open',
          priority: reply.createTicket.priority,
          channel: prev.session.channel,
          notificationBody: notifBody,
        })
        tickets = [ticket, ...tickets]
      } else if (reply.escalate) {
        const ticket: StaffTicket = normalizeTicket({
          id: crypto.randomUUID(),
          reason: 'Guest requested human agent',
          summary: 'Warm handoff: guest asked for a colleague',
          guestName: booking.guestName || 'Guest',
          phone: booking.phone || '-',
          timestamp: Date.now(),
          status: 'open',
          priority: 'normal',
          channel: prev.session.channel,
          notificationBody: notifBody,
        })
        tickets = [ticket, ...tickets]
      }
      if (reply.escalate) {
        notifications = [
          {
            id: crypto.randomUUID(),
            channel: 'email',
            subject: 'Human takeover requested',
            body: `Guest asked for an agent. Name: ${booking.guestName || '-'} · Phone: ${booking.phone || '-'} · Channel: ${prev.session.channel}`,
            timestamp: Date.now(),
            read: false,
          },
          ...notifications,
        ]
      }

      let auditLog = prev.auditLog
      if (reply.createNotification) {
        auditLog = appendAudit(
          auditLog,
          'ai',
          'desk_alert',
          reply.createNotification.subject,
          prev.session.id,
        )
      }
      if (reply.escalate || reply.createTicket) {
        auditLog = appendAudit(
          auditLog,
          'ai',
          'ticket_opened',
          reply.createTicket?.reason || 'Human escalate',
          prev.session.id,
        )
      }

      const session = {
        ...prev.session,
        status: (reply.end ? 'completed' : 'in_call') as DemoStoreData['session']['status'],
        step: reply.nextStep,
        intent: reply.intent ?? prev.session.intent,
        booking,
        transcript: [...prev.session.transcript, guestEntry, aiEntry],
        toolLogs: logs,
        outcome: reply.outcome ?? prev.session.outcome,
        startedAt: prev.session.startedAt ?? Date.now(),
        endedAt: reply.end ? Date.now() : prev.session.endedAt,
      }

      let guestProfiles = prev.guestProfiles
      if (reply.end && reply.outcome && booking.phone && booking.guestName) {
        guestProfiles = upsertGuestProfile(guestProfiles, booking)
      }

      const next: DemoStoreData = syncActiveSession(
        {
          ...prev,
          notifications,
          tickets,
          auditLog,
          guestProfiles,
        },
        session,
      )

      if (reply.end && reply.outcome) {
        const already = prev.history.some((h) => h.id === session.id)
        if (already) return next
        return archiveIfEnded(next, session, reply.outcome, reply.createNotification?.body || replyText)
      }
      return next
    })
    if (telemetry.turn) recordEngineTurn(telemetry.turn)
    return aiText
  }, [archiveIfEnded])

  const applyScriptedTurn = useCallback(
    (speaker: Speaker, text: string, bookingPatch?: Partial<DemoStoreData['session']['booking']>) => {
      setData((prev) =>
        syncActiveSession(prev, {
          ...prev.session,
          status: 'in_call',
          booking: bookingPatch ? { ...prev.session.booking, ...bookingPatch } : prev.session.booking,
          transcript: [
            ...prev.session.transcript,
            { id: crypto.randomUUID(), speaker, text, timestamp: Date.now() },
          ],
          toolLogs:
            speaker === 'AI'
              ? pushLog(prev.session.toolLogs, 'scripted_tts', { text: text.slice(0, 80) }, 'Played')
              : prev.session.toolLogs,
        }),
      )
    },
    [],
  )

  const finalizeScriptedBooking = useCallback(() => {
    setData((prev) => {
      const booking = {
        ...prev.session.booking,
        guestName: prev.session.booking.guestName || 'Ahmed Al Mansoori',
        phone: prev.session.booking.phone || '+971 50 555 5555',
        checkIn: prev.session.booking.checkIn || '2026-10-10',
        checkOut: prev.session.booking.checkOut || '2026-10-13',
        rooms: prev.session.booking.rooms ?? 1,
        adults: prev.session.booking.adults ?? 2,
        children: prev.session.booking.children ?? 1,
        specialRequests: prev.session.booking.specialRequests || 'Late check-in after 10pm',
      }
      const body =
        'Desk unavailable / after-hours: AI captured inquiry: Ahmed Al Mansoori, 2 adults 1 child, 10–13 Oct, late check-in. Please call back to confirm availability/rate.'
      const subject = 'Missed desk pickup → reservation inquiry'
      let logs = prev.session.toolLogs
      logs = pushLog(logs, 'update_booking_fields', booking as unknown as Record<string, unknown>, 'Scripted fields set')
      logs = pushLog(logs, 'confirm_booking_summary', { confirmed: true }, 'Guest confirmed')
      logs = pushLog(logs, 'create_desk_notification', { subject, body }, 'Desk notified')
      logs = pushLog(logs, 'end_conversation', { outcome: 'after_hours_saved' }, 'Inquiry saved')

      const session = {
        ...prev.session,
        booking,
        step: 'completed' as const,
        outcome: 'after_hours_saved' as const,
        status: 'completed' as const,
        endedAt: Date.now(),
        toolLogs: logs,
      }

      const notifications = [
        {
          id: crypto.randomUUID(),
          channel: 'whatsapp' as const,
          subject,
          body,
          timestamp: Date.now(),
          read: false,
        },
        ...prev.notifications,
      ]

      const record: CallRecord = {
        id: session.id,
        timestamp: Date.now(),
        channel: session.channel,
        outcome: 'after_hours_saved',
        guestName: booking.guestName,
        summary: body,
        booking,
      }

      return syncActiveSession(
        {
          ...prev,
          notifications,
          history: [record, ...prev.history].slice(0, 30),
        },
        session,
      )
    })
  }, [])

  const escalateNow = useCallback((reason = 'Guest requested agent') => {
    setData((prev) => {
      const booking = prev.session.booking
      const logs = pushLog(prev.session.toolLogs, 'escalate_to_human', { reason }, 'Ticket created')
      const ticket = normalizeTicket({
        id: crypto.randomUUID(),
        reason,
        summary: reason,
        guestName: booking.guestName || 'Guest',
        phone: booking.phone || '-',
        timestamp: Date.now(),
        status: 'open',
        priority: 'normal',
        channel: prev.session.channel,
      })
      const session = {
        ...prev.session,
        step: 'escalated' as const,
        outcome: 'transferred' as const,
        status: 'completed' as const,
        endedAt: Date.now(),
        toolLogs: logs,
        transcript: [
          ...prev.session.transcript,
          {
            id: crypto.randomUUID(),
            speaker: 'AI' as const,
            text: 'Of course. I’ll connect you with a reservations colleague and leave a short summary.',
            timestamp: Date.now(),
          },
        ],
      }
      const record: CallRecord = {
        id: session.id,
        timestamp: Date.now(),
        channel: session.channel,
        outcome: 'transferred',
        guestName: ticket.guestName,
        summary: reason,
        booking,
      }
      return syncActiveSession(
        {
          ...prev,
          tickets: [ticket, ...prev.tickets],
          notifications: [
            {
              id: crypto.randomUUID(),
              channel: 'email',
              subject: 'Human takeover requested',
              body: `${reason} · ${ticket.guestName} · ${ticket.phone}`,
              timestamp: Date.now(),
              read: false,
            },
            ...prev.notifications,
          ],
          history: [record, ...prev.history].slice(0, 30),
        },
        session,
      )
    })
  }, [])

  const resetDemo = useCallback(() => {
    setData(resetStore())
  }, [])

  const markNotificationRead = useCallback((id: string) => {
    setData((prev) => ({
      ...prev,
      notifications: prev.notifications.map((n) => (n.id === id ? { ...n, read: true } : n)),
    }))
  }, [])

  const claimTicket = useCallback((id: string, agentName = 'Reservations') => {
    setData((prev) => ({
      ...prev,
      tickets: prev.tickets.map((t) =>
        t.id === id ? { ...t, status: 'claimed' as const, claimedBy: agentName } : t,
      ),
    }))
  }, [])

  const markTicketDone = useCallback((id: string) => {
    setData((prev) => ({
      ...prev,
      tickets: prev.tickets.map((t) => (t.id === id ? { ...t, status: 'done' as const } : t)),
    }))
  }, [])

  const value = useMemo<DemoContextValue>(
    () => ({
      ...data,
      appendTranscript,
      setSettings,
      startSession,
      setStatus,
      sendGuestMessage,
      runGreeting,
      applyScriptedTurn,
      finalizeScriptedBooking,
      escalateNow,
      resetDemo,
      markNotificationRead,
      claimTicket,
      markTicketDone,
      pushAudit,
      recallGuestByPhone,
      switchSession,
      spawnOverflowLine,
      closeSessionLine,
    }),
    [
      data,
      appendTranscript,
      setSettings,
      startSession,
      setStatus,
      sendGuestMessage,
      runGreeting,
      applyScriptedTurn,
      finalizeScriptedBooking,
      escalateNow,
      resetDemo,
      markNotificationRead,
      claimTicket,
      markTicketDone,
      pushAudit,
      recallGuestByPhone,
      switchSession,
      spawnOverflowLine,
      closeSessionLine,
    ],
  )

  return <DemoContext.Provider value={value}>{children}</DemoContext.Provider>
}

export function useDemo() {
  const ctx = useContext(DemoContext)
  if (!ctx) throw new Error('useDemo must be used within DemoProvider')
  return ctx
}

export type { Language }
