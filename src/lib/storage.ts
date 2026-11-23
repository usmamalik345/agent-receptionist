import type { DemoStoreData, Language, SessionState } from './types'
import { emptyBooking, normalizeTicket } from './types'

const STORAGE_KEY_PREFIX = 'receptionist-demo-v2-'

export function storageKeyForBiz(slug: string): string {
  return `${STORAGE_KEY_PREFIX}${slug || 'erth'}`
}

/** @deprecated Prefer storageKeyForBiz — kept for one-time migration */
const LEGACY_STORAGE_KEY = 'desert-palm-receptionist-demo-v1'

let activeStorageKey = storageKeyForBiz('erth')

export function setDemoStorageSlug(slug: string) {
  activeStorageKey = storageKeyForBiz(slug)
}

export function getDemoStorageKey() {
  return activeStorageKey
}
export const MAX_OVERFLOW_LINES = 5

export function createEmptySession(language: Language = 'en', line = 1): SessionState {
  return {
    id: crypto.randomUUID(),
    line,
    channel: 'voice',
    status: 'idle',
    step: 'idle',
    intent: null,
    booking: emptyBooking(language),
    outcome: null,
    transcript: [],
    toolLogs: [],
    startedAt: null,
    endedAt: null,
  }
}

/** Keep `session` and `sessions[]` in sync after any mutation. */
export function syncActiveSession(data: DemoStoreData, session: SessionState): DemoStoreData {
  const exists = data.sessions.some((s) => s.id === session.id)
  const sessions = exists
    ? data.sessions.map((s) => (s.id === session.id ? session : s))
    : [...data.sessions, session].slice(0, MAX_OVERFLOW_LINES)
  return {
    ...data,
    session,
    sessions,
    activeSessionId: session.id,
  }
}

export function defaultStore(): DemoStoreData {
  const session = createEmptySession('en', 1)
  return {
    settings: {
      language: 'en',
      afterHours: true,
      humanTakeover: false,
      aiPaused: false,
      operaReadEnabled: false,
      operaWriteUnlocked: false,
    },
    session,
    sessions: [session],
    activeSessionId: session.id,
    notifications: [],
    history: [],
    tickets: [],
    auditLog: [],
    guestProfiles: [],
  }
}

export function loadStore(): DemoStoreData {
  try {
    let raw = localStorage.getItem(activeStorageKey)
    // One-time migrate legacy Erth key into erth slug store
    if (!raw && activeStorageKey === storageKeyForBiz('erth')) {
      raw = localStorage.getItem(LEGACY_STORAGE_KEY)
    }
    if (!raw) return defaultStore()
    const parsed = JSON.parse(raw) as DemoStoreData
    const base = defaultStore()
    const session = parsed.session
      ? { ...createEmptySession(), ...parsed.session, line: parsed.session.line || 1 }
      : createEmptySession()
    let sessions = (parsed.sessions ?? []).map((s, i) => ({
      ...createEmptySession(),
      ...s,
      line: s.line || i + 1,
    }))
    if (!sessions.length) sessions = [session]
    if (!sessions.some((s) => s.id === session.id)) {
      sessions = [session, ...sessions].slice(0, MAX_OVERFLOW_LINES)
    }
    const activeSessionId = parsed.activeSessionId || session.id
    const active = sessions.find((s) => s.id === activeSessionId) || session
    return {
      ...base,
      ...parsed,
      settings: { ...base.settings, ...parsed.settings },
      session: active,
      sessions,
      activeSessionId: active.id,
      notifications: parsed.notifications ?? [],
      history: (parsed.history ?? []).slice(0, 30),
      tickets: (parsed.tickets ?? []).map((t) => normalizeTicket(t)),
      auditLog: (parsed.auditLog ?? []).slice(0, 200),
      guestProfiles: parsed.guestProfiles ?? [],
    }
  } catch {
    return defaultStore()
  }
}

export function saveStore(data: DemoStoreData): void {
  try {
    const toSave: DemoStoreData = {
      ...data,
      history: data.history.slice(0, 30),
      tickets: data.tickets.map((t) => normalizeTicket(t)),
      auditLog: data.auditLog.slice(0, 200),
      guestProfiles: data.guestProfiles.slice(0, 40),
      sessions: data.sessions.slice(0, MAX_OVERFLOW_LINES),
    }
    localStorage.setItem(activeStorageKey, JSON.stringify(toSave))
  } catch {
    /* ignore quota */
  }
}

export function resetStore(): DemoStoreData {
  const fresh = defaultStore()
  saveStore(fresh)
  return fresh
}

export const OVERFLOW_DEMO_GUESTS: Array<{
  guestName: string
  phone: string
  checkIn: string
  checkOut: string
  adults: number
  children: number
  special: string
  opener: string
}> = [
  {
    guestName: 'Layla Hassan',
    phone: '+971501112233',
    checkIn: '2026-11-05',
    checkOut: '2026-11-08',
    adults: 2,
    children: 1,
    special: 'Connecting rooms',
    opener: 'Need a room for 2 adults and 1 child, 5 to 8 November',
  },
  {
    guestName: 'Omar Farid',
    phone: '+971509998877',
    checkIn: '2026-10-18',
    checkOut: '2026-10-20',
    adults: 2,
    children: 0,
    special: 'Late check-in',
    opener: 'AC not working in room 412',
  },
  {
    guestName: 'Sara Khan',
    phone: '+971505551212',
    checkIn: '2026-12-02',
    checkOut: '2026-12-04',
    adults: 4,
    children: 0,
    special: '2 couple rooms',
    opener: 'We are 2 couples — need 2 rooms from 2 December for 2 nights',
  },
  {
    guestName: 'Yousef Ali',
    phone: '+971507774455',
    checkIn: '2026-10-25',
    checkOut: '2026-10-27',
    adults: 1,
    children: 0,
    special: 'Business desk callback',
    opener: 'Change my existing Booking.com reservation',
  },
]
