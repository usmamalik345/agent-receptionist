export type Intent =
  | 'reservation'
  | 'modify'
  | 'dining'
  | 'spa'
  | 'faq'
  | 'rates'
  | 'human'
  | 'confirm'
  | 'deny'
  | 'complaint'
  | 'goodbye'
  | 'unknown'
  // Dental industry intents (mapped onto shared engine)
  | 'new_patient'
  | 'existing_patient'
  | 'emergency'
  | 'membership'
  | 'hours'
  | 'location'
  | 'nervous'
  | 'nhs'

export type CallStatus = 'idle' | 'ringing' | 'in_call' | 'completed'

export type Outcome =
  | 'booked_inquiry'
  | 'callback_requested'
  | 'transferred'
  | 'after_hours_saved'
  | null

export type Channel = 'voice' | 'whatsapp' | 'scripted'

export type Speaker = 'Guest' | 'AI' | 'Agent'

export type Language = 'en' | 'ar'

export type TicketPriority = 'normal' | 'high' | 'urgent'
export type TicketStatus = 'open' | 'claimed' | 'done'

export type ConversationStep =
  | 'idle'
  | 'greeted'
  | 'await_intent'
  | 'collect_check_in'
  | 'collect_check_out'
  | 'collect_rooms'
  | 'collect_room_type'
  | 'collect_guests'
  | 'collect_name'
  | 'collect_phone'
  | 'collect_special'
  | 'confirm_summary'
  | 'dining_details'
  | 'complaint_details'
  | 'modify_collect'
  | 'faq'
  | 'escalated'
  | 'completed'
  // Dental collect steps
  | 'collect_patient_type'
  | 'collect_practice'
  | 'collect_reason'
  | 'collect_preferred_time'

export interface BookingFields {
  guestName: string
  phone: string
  checkIn: string
  checkOut: string
  rooms: number | null
  adults: number | null
  children: number | null
  /** Preferred category from erth.ae list, e.g. Al Muradi Family Suite */
  roomCategory: string
  specialRequests: string
  language: Language
  diningDate?: string
  diningTime?: string
  diningParty?: number | null
  diningNotes?: string
  confirmationNumber?: string
  modifyRequest?: string
  /** Dental: new | existing */
  patientType?: string
  /** Dental: practice name or "no preference" */
  practice?: string
  /** Dental: reason / treatment */
  reason?: string
  /** Dental: preferred day and time */
  preferredDayTime?: string
  /** Dental / shared emergency flag */
  isEmergency?: boolean
}

export interface TranscriptEntry {
  id: string
  speaker: Speaker
  text: string
  timestamp: number
}

export interface ToolLog {
  id: string
  tool: string
  args: Record<string, unknown>
  result: string
  timestamp: number
}

export interface DeskNotification {
  id: string
  channel: 'whatsapp' | 'email'
  subject: string
  body: string
  timestamp: number
  read: boolean
}

export interface CallRecord {
  id: string
  timestamp: number
  channel: Channel
  outcome: Outcome
  guestName: string
  summary: string
  booking: BookingFields
}

export interface StaffTicket {
  id: string
  reason: string
  summary: string
  guestName: string
  phone: string
  timestamp: number
  status: TicketStatus
  priority: TicketPriority
  channel: Channel
  claimedBy?: string
  notificationBody?: string
}

/** IT-facing immutable-ish event stream (demo localStorage). */
export interface AuditEvent {
  id: string
  timestamp: number
  actor: 'system' | 'ai' | 'guest' | 'ops' | 'it'
  action: string
  detail: string
  sessionId?: string
}

/** Returning-guest profile keyed by normalized phone digits. */
export interface GuestProfile {
  phoneDigits: string
  guestName: string
  language: Language
  lastCheckIn: string
  lastCheckOut: string
  lastSpecial: string
  roomCategory: string
  visitCount: number
  lastSeenAt: number
}

export interface DemoSettings {
  language: Language
  afterHours: boolean
  humanTakeover: boolean
  /** IT kill switch: pause AI, queue / escalate only */
  aiPaused: boolean
  /** Sandbox Opera availability read stub */
  operaReadEnabled: boolean
  /** Write-back to Opera — locked until IT unlocks */
  operaWriteUnlocked: boolean
}

export interface SessionState {
  id: string
  /** Display label e.g. Line 1 */
  line: number
  channel: Channel
  status: CallStatus
  step: ConversationStep
  intent: Intent | null
  booking: BookingFields
  outcome: Outcome
  transcript: TranscriptEntry[]
  toolLogs: ToolLog[]
  startedAt: number | null
  endedAt: number | null
}

export interface DemoStoreData {
  settings: DemoSettings
  /** Active session (same object as sessions[active]) */
  session: SessionState
  /** Parallel overflow lines (max 5) */
  sessions: SessionState[]
  activeSessionId: string
  notifications: DeskNotification[]
  history: CallRecord[]
  tickets: StaffTicket[]
  auditLog: AuditEvent[]
  guestProfiles: GuestProfile[]
}

export const emptyBooking = (language: Language = 'en'): BookingFields => ({
  guestName: '',
  phone: '',
  checkIn: '',
  checkOut: '',
  rooms: null,
  adults: null,
  children: null,
  roomCategory: '',
  specialRequests: '',
  language,
  diningDate: '',
  diningTime: '',
  diningParty: null,
  diningNotes: '',
  confirmationNumber: '',
  modifyRequest: '',
  patientType: '',
  practice: '',
  reason: '',
  preferredDayTime: '',
  isEmergency: false,
})

export const outcomeLabel = (o: Outcome): string => {
  switch (o) {
    case 'booked_inquiry':
      return 'Booked inquiry'
    case 'callback_requested':
      return 'Callback requested'
    case 'transferred':
      return 'Transferred'
    case 'after_hours_saved':
      return 'After-hours message saved'
    default:
      return '-'
  }
}

/** Normalize legacy tickets from localStorage */
export function normalizeTicket(raw: Partial<StaffTicket> & { reason?: string }): StaffTicket {
  return {
    id: raw.id || crypto.randomUUID(),
    reason: raw.reason || 'Ticket',
    summary: raw.summary || raw.reason || 'Ticket',
    guestName: raw.guestName || 'Guest',
    phone: raw.phone || '-',
    timestamp: raw.timestamp || Date.now(),
    status: raw.status === 'claimed' || raw.status === 'done' ? raw.status : 'open',
    priority: raw.priority === 'urgent' ? 'urgent' : raw.priority === 'high' ? 'high' : 'normal',
    channel: raw.channel === 'whatsapp' || raw.channel === 'scripted' ? raw.channel : 'voice',
    claimedBy: raw.claimedBy,
    notificationBody: raw.notificationBody,
  }
}
