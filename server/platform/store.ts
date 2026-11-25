/**
 * Local booking store (in-process). Every read and write is scoped by tenant id;
 * there is no API that lists or reads another tenant's data. Availability is derived
 * from the tenant's config (opening hours / room counts) minus existing bookings.
 * Swap for a database by implementing `BookingStore` (same tenant-scoped methods).
 */
import { addDays, nightsBetween, weekdayOf } from './extract.ts'
import type { Tenant } from './tenant.ts'

export interface Booking {
  ref: string
  tenantId: string
  kind: 'appointment' | 'room'
  name: string
  phone: string
  createdAt: string
  // appointment
  treatment?: string
  location?: string
  date?: string
  time?: string
  // room
  roomType?: string
  checkIn?: string
  checkOut?: string
  guests?: number
  totalPrice?: number
  /** call that made the booking (server-side only) */
  callId?: string
}

export type RoomOption = { type: string; ratePerNight: number | null; nights: number; total: number | null; left: number }

type NewBooking = Omit<Booking, 'ref' | 'tenantId' | 'kind' | 'createdAt'>

/**
 * Tenant-scoped booking repository. Async so the same interface fits the in-memory store
 * (tests, browser demo) and the SQL store (Postgres in production, SQLite locally): see server/db/.
 */
export interface BookingStore {
  appointmentSlots(t: Tenant, q: { date: string; location: string; durationMin: number }): Promise<string[]>
  roomOptions(t: Tenant, q: { checkIn: string; checkOut: string; guests: number }): Promise<RoomOption[]>
  createAppointment(t: Tenant, b: NewBooking): Promise<Booking>
  createRoomBooking(t: Tenant, b: NewBooking): Promise<Booking>
  list(tenantId: string): Promise<Booking[]>
}

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const
const toMin = (s: string) => {
  const m = s.trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/)
  if (!m) return null
  return ((Number(m[1]) % 12) + (m[3] === 'pm' ? 12 : 0)) * 60 + Number(m[2] ?? 0)
}
const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`

/** "8:30am–5pm" -> [510, 1020]; "closed" / unknown -> null */
export function openRange(hours: string): [number, number] | null {
  const parts = hours.split(/\s*[–-]\s*/)
  if (parts.length < 2) return null
  const a = toMin(parts[0])
  const b = toMin(parts[1].replace(/\s.*$/, '').trim())
  return a !== null && b !== null && b > a ? [a, b] : null
}

/** Bookable start times ("HH:MM") for one clinic location/day, minus the times already taken. */
export function freeSlots(t: Tenant, q: { date: string; location: string; durationMin: number }, taken: Set<string>): string[] {
  const loc = t.locations.find((l) => l.name === q.location)
  if (!loc || !t.dental) return []
  const hours = loc.hours[DAY_KEYS[weekdayOf(q.date)]]
  // "phone lines only" etc. are not bookable
  if (!hours || /only/i.test(hours)) return []
  const range = openRange(hours)
  if (!range) return []
  const out: string[] = []
  for (let m = range[0]; m + q.durationMin <= range[1]; m += t.dental.slotMinutes) if (!taken.has(hhmm(m))) out.push(hhmm(m))
  return out
}

/** Nights of a stay, "YYYY-MM-DD" each; [] when the range is invalid or longer than 30 nights. */
export function stayNights(checkIn: string, checkOut: string): string[] {
  const n = nightsBetween(checkIn, checkOut)
  if (n < 1 || n > 30) return []
  return Array.from({ length: n }, (_, i) => addDays(checkIn, i))
}

/** Room types with rooms left on every night of the stay, cheapest first. `used(type, night)` = rooms already sold. */
export function roomAvailability(t: Tenant, q: { checkIn: string; checkOut: string; guests: number }, used: (type: string, night: string) => number): RoomOption[] {
  if (!t.hotel) return []
  const nights = stayNights(q.checkIn, q.checkOut)
  if (!nights.length) return []
  return t.hotel.rooms
    .filter((r) => r.maxGuests >= q.guests)
    .map((r) => {
      let left = r.count
      for (const night of nights) left = Math.min(left, r.count - used(r.type, night))
      return { type: r.type, ratePerNight: r.ratePerNight, nights: nights.length, total: r.ratePerNight === null ? null : r.ratePerNight * nights.length, left }
    })
    .filter((o) => o.left > 0)
    .sort((a, b) => (a.ratePerNight ?? Infinity) - (b.ratePerNight ?? Infinity))
}

export const bookingRef = (t: Tenant): string => `${t.vertical === 'hotel' ? 'H' : 'D'}${1000 + (globalThis.crypto.getRandomValues(new Uint32Array(1))[0] % 9000)}`
export const appointmentDuration = (t: Tenant, treatment: string | undefined): number => t.dental?.treatments.find((x) => x.name === treatment)?.durationMin ?? 30

/** In-process store: tests, evals and the browser demo. Check-then-write runs in one tick, so it is atomic. */
export class MemoryBookingStore implements BookingStore {
  private readonly byTenant = new Map<string, Booking[]>()

  private rows(tenantId: string): Booking[] {
    let r = this.byTenant.get(tenantId)
    if (!r) this.byTenant.set(tenantId, (r = []))
    return r
  }

  private slots(t: Tenant, q: { date: string; location: string; durationMin: number }): string[] {
    const taken = new Set(this.rows(t.id).filter((b) => b.kind === 'appointment' && b.date === q.date && b.location === q.location).map((b) => b.time!))
    return freeSlots(t, q, taken)
  }

  private rooms(t: Tenant, q: { checkIn: string; checkOut: string; guests: number }): RoomOption[] {
    const rows = this.rows(t.id).filter((b) => b.kind === 'room')
    return roomAvailability(t, q, (type, night) => rows.filter((b) => b.roomType === type && b.checkIn! <= night && night < b.checkOut!).length)
  }

  async appointmentSlots(t: Tenant, q: { date: string; location: string; durationMin: number }): Promise<string[]> {
    return this.slots(t, q)
  }

  async roomOptions(t: Tenant, q: { checkIn: string; checkOut: string; guests: number }): Promise<RoomOption[]> {
    return this.rooms(t, q)
  }

  async createAppointment(t: Tenant, b: NewBooking): Promise<Booking> {
    if (!this.slots(t, { date: b.date!, location: b.location!, durationMin: appointmentDuration(t, b.treatment) }).includes(b.time!)) throw new Error('slot_unavailable')
    const row: Booking = { ...b, ref: bookingRef(t), tenantId: t.id, kind: 'appointment', createdAt: new Date().toISOString() }
    this.rows(t.id).push(row)
    return { ...row }
  }

  async createRoomBooking(t: Tenant, b: NewBooking): Promise<Booking> {
    const opt = this.rooms(t, { checkIn: b.checkIn!, checkOut: b.checkOut!, guests: b.guests! }).find((o) => o.type === b.roomType)
    if (!opt) throw new Error('room_unavailable')
    const row: Booking = { ...b, totalPrice: opt.total ?? undefined, ref: bookingRef(t), tenantId: t.id, kind: 'room', createdAt: new Date().toISOString() }
    this.rows(t.id).push(row)
    return { ...row }
  }

  async list(tenantId: string): Promise<Booking[]> {
    return this.rows(tenantId).map((b) => ({ ...b }))
  }
}
