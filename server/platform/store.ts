/**
 * Local booking store (in-process). Every read and write is scoped by tenant id;
 * there is no API that lists or reads another tenant's data. Availability is derived
 * from the tenant's config (opening hours / room counts) minus existing bookings.
 * Swap for a database by implementing `BookingStore` (same tenant-scoped methods).
 */
import { randomInt } from 'node:crypto'
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
}

export interface BookingStore {
  appointmentSlots(t: Tenant, q: { date: string; location: string; durationMin: number }): string[]
  roomOptions(t: Tenant, q: { checkIn: string; checkOut: string; guests: number }): Array<{ type: string; ratePerNight: number; nights: number; total: number; left: number }>
  createAppointment(t: Tenant, b: Omit<Booking, 'ref' | 'tenantId' | 'kind' | 'createdAt'>): Booking
  createRoomBooking(t: Tenant, b: Omit<Booking, 'ref' | 'tenantId' | 'kind' | 'createdAt'>): Booking
  list(tenantId: string): Booking[]
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

export class MemoryBookingStore implements BookingStore {
  private readonly byTenant = new Map<string, Booking[]>()

  private rows(tenantId: string): Booking[] {
    let r = this.byTenant.get(tenantId)
    if (!r) this.byTenant.set(tenantId, (r = []))
    return r
  }

  appointmentSlots(t: Tenant, q: { date: string; location: string; durationMin: number }): string[] {
    const loc = t.locations.find((l) => l.name === q.location)
    if (!loc || !t.dental) return []
    const hours = loc.hours[DAY_KEYS[weekdayOf(q.date)]]
    // "phone lines only" etc. are not bookable
    if (/only/i.test(hours)) return []
    const range = openRange(hours)
    if (!range) return []
    const taken = new Set(this.rows(t.id).filter((b) => b.kind === 'appointment' && b.date === q.date && b.location === q.location).map((b) => b.time))
    const out: string[] = []
    for (let m = range[0]; m + q.durationMin <= range[1]; m += t.dental.slotMinutes) if (!taken.has(hhmm(m))) out.push(hhmm(m))
    return out
  }

  roomOptions(t: Tenant, q: { checkIn: string; checkOut: string; guests: number }) {
    if (!t.hotel) return []
    const nights = nightsBetween(q.checkIn, q.checkOut)
    if (nights < 1 || nights > 30) return []
    const rows = this.rows(t.id).filter((b) => b.kind === 'room')
    return t.hotel.rooms
      .filter((r) => r.maxGuests >= q.guests)
      .map((r) => {
        let minLeft = r.count
        for (let i = 0; i < nights; i++) {
          const night = addDays(q.checkIn, i)
          const used = rows.filter((b) => b.roomType === r.type && b.checkIn! <= night && night < b.checkOut!).length
          minLeft = Math.min(minLeft, r.count - used)
        }
        return { type: r.type, ratePerNight: r.ratePerNight, nights, total: r.ratePerNight * nights, left: minLeft }
      })
      .filter((o) => o.left > 0)
      .sort((a, b) => a.ratePerNight - b.ratePerNight)
  }

  private ref(t: Tenant): string {
    return `${t.vertical === 'hotel' ? 'H' : 'D'}${randomInt(1000, 9999)}`
  }

  createAppointment(t: Tenant, b: Omit<Booking, 'ref' | 'tenantId' | 'kind' | 'createdAt'>): Booking {
    const dur = t.dental?.treatments.find((x) => x.name === b.treatment)?.durationMin ?? 30
    if (!this.appointmentSlots(t, { date: b.date!, location: b.location!, durationMin: dur }).includes(b.time!)) throw new Error('slot_unavailable')
    const row: Booking = { ...b, ref: this.ref(t), tenantId: t.id, kind: 'appointment', createdAt: new Date().toISOString() }
    this.rows(t.id).push(row)
    return row
  }

  createRoomBooking(t: Tenant, b: Omit<Booking, 'ref' | 'tenantId' | 'kind' | 'createdAt'>): Booking {
    const opt = this.roomOptions(t, { checkIn: b.checkIn!, checkOut: b.checkOut!, guests: b.guests! }).find((o) => o.type === b.roomType)
    if (!opt) throw new Error('room_unavailable')
    const row: Booking = { ...b, totalPrice: opt.total, ref: this.ref(t), tenantId: t.id, kind: 'room', createdAt: new Date().toISOString() }
    this.rows(t.id).push(row)
    return row
  }

  list(tenantId: string): Booking[] {
    return this.rows(tenantId).map((b) => ({ ...b }))
  }
}
