/**
 * SQL implementation of BookingStore (Postgres or SQLite). Same availability rules as the
 * in-memory store (pure helpers in server/platform/store.ts); the database adds the guarantees:
 *   - appointments: partial unique index bookings_one_per_slot -> two callers can't get one slot;
 *   - rooms: one room_nights row per sold unit-night with a primary key -> no overselling;
 *   - every statement filters on tenant_id and runs in Db.tenantTx (RLS on Postgres).
 */
import { appointmentDuration, bookingRef, freeSlots, roomAvailability, stayNights, type Booking, type BookingStore, type RoomOption } from '../platform/store.ts'
import type { Tenant } from '../platform/tenant.ts'
import { UniqueViolation, type Db, type Queryer, type Row } from './sql.ts'

type NewBooking = Omit<Booking, 'ref' | 'tenantId' | 'kind' | 'createdAt'>
const ATTEMPTS = 5

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v))
const isSlotClash = (e: UniqueViolation) => /one_per_slot|appt_time/.test(e.constraint)

export function rowToBooking(r: Row): Booking {
  const b: Booking = { ref: String(r.ref), tenantId: String(r.tenant_id), kind: r.kind as Booking['kind'], name: String(r.name), phone: String(r.phone), createdAt: iso(r.created_at) }
  const opt = (k: keyof Booking, v: unknown) => { if (v !== null && v !== undefined) (b as unknown as Record<string, unknown>)[k] = v }
  opt('treatment', r.treatment); opt('location', r.location); opt('date', r.appt_date); opt('time', r.appt_time)
  opt('roomType', r.room_type); opt('checkIn', r.check_in); opt('checkOut', r.check_out)
  opt('guests', r.guests === null || r.guests === undefined ? null : Number(r.guests))
  opt('totalPrice', r.total_price === null || r.total_price === undefined ? null : Number(r.total_price))
  opt('callId', r.call_id)
  return b
}

export class SqlBookingStore implements BookingStore {
  private readonly db: Db
  constructor(db: Db) {
    this.db = db
  }

  private async taken(q: Queryer, tenantId: string, date: string, location: string): Promise<Set<string>> {
    const rows = await q.query<{ appt_time: string }>(
      "SELECT appt_time FROM bookings WHERE tenant_id = $1 AND kind = 'appointment' AND status = 'confirmed' AND appt_date = $2 AND location = $3",
      [tenantId, date, location],
    )
    return new Set(rows.map((r) => r.appt_time))
  }

  private async sold(q: Queryer, tenantId: string, checkIn: string, checkOut: string): Promise<Map<string, number>> {
    const rows = await q.query<{ room_type: string; night: string; n: number }>(
      'SELECT room_type, night, COUNT(*) AS n FROM room_nights WHERE tenant_id = $1 AND night >= $2 AND night < $3 GROUP BY room_type, night',
      [tenantId, checkIn, checkOut],
    )
    return new Map(rows.map((r) => [`${r.room_type}|${r.night}`, Number(r.n)]))
  }

  private async rooms(q: Queryer, t: Tenant, s: { checkIn: string; checkOut: string; guests: number }): Promise<RoomOption[]> {
    const sold = await this.sold(q, t.id, s.checkIn, s.checkOut)
    return roomAvailability(t, s, (type, night) => sold.get(`${type}|${night}`) ?? 0)
  }

  async appointmentSlots(t: Tenant, q: { date: string; location: string; durationMin: number }): Promise<string[]> {
    return this.db.tenantTx(t.id, async (x) => freeSlots(t, q, await this.taken(x, t.id, q.date, q.location)))
  }

  async roomOptions(t: Tenant, q: { checkIn: string; checkOut: string; guests: number }): Promise<RoomOption[]> {
    return this.db.tenantTx(t.id, (x) => this.rooms(x, t, q))
  }

  async createAppointment(t: Tenant, b: NewBooking): Promise<Booking> {
    for (let i = 0; i < ATTEMPTS; i++) {
      try {
        return await this.db.tenantTx(t.id, async (x) => {
          const free = freeSlots(t, { date: b.date!, location: b.location!, durationMin: appointmentDuration(t, b.treatment) }, await this.taken(x, t.id, b.date!, b.location!))
          if (!free.includes(b.time!)) throw new Error('slot_unavailable')
          const rows = await x.query(
            `INSERT INTO bookings (tenant_id, ref, kind, name, phone, treatment, location, appt_date, appt_time, call_id, created_at)
             VALUES ($1, $2, 'appointment', $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
            [t.id, bookingRef(t), b.name, b.phone, b.treatment ?? null, b.location, b.date, b.time, b.callId ?? null, new Date().toISOString()],
          )
          return rowToBooking(rows[0])
        })
      } catch (e) {
        if (e instanceof UniqueViolation && isSlotClash(e)) throw new Error('slot_unavailable', { cause: e })
        if (!(e instanceof UniqueViolation)) throw e
        // booking ref collision: try a new ref
      }
    }
    throw new Error('booking_ref_exhausted')
  }

  async createRoomBooking(t: Tenant, b: NewBooking): Promise<Booking> {
    const room = t.hotel?.rooms.find((r) => r.type === b.roomType)
    const nights = stayNights(b.checkIn!, b.checkOut!)
    if (!room || !nights.length) throw new Error('room_unavailable')
    for (let i = 0; i < ATTEMPTS; i++) {
      try {
        return await this.db.tenantTx(t.id, async (x) => {
          const opt = (await this.rooms(x, t, { checkIn: b.checkIn!, checkOut: b.checkOut!, guests: b.guests! })).find((o) => o.type === b.roomType)
          if (!opt) throw new Error('room_unavailable')
          const ref = bookingRef(t)
          const rows = await x.query(
            `INSERT INTO bookings (tenant_id, ref, kind, name, phone, room_type, check_in, check_out, guests, total_price, call_id, created_at)
             VALUES ($1, $2, 'room', $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
            [t.id, ref, b.name, b.phone, b.roomType, b.checkIn, b.checkOut, b.guests ?? null, opt.total, b.callId ?? null, new Date().toISOString()],
          )
          for (const night of nights) {
            const used = new Set((await x.query<{ unit: number }>('SELECT unit FROM room_nights WHERE tenant_id = $1 AND room_type = $2 AND night = $3', [t.id, room.type, night])).map((r) => Number(r.unit)))
            let unit = 1
            while (used.has(unit)) unit++
            if (unit > room.count) throw new Error('room_unavailable')
            await x.query('INSERT INTO room_nights (tenant_id, room_type, night, unit, booking_ref) VALUES ($1, $2, $3, $4, $5)', [t.id, room.type, night, unit, ref])
          }
          return rowToBooking(rows[0])
        })
      } catch (e) {
        // unit taken by a concurrent booking or ref collision: re-check availability and retry
        if (!(e instanceof UniqueViolation)) throw e
      }
    }
    throw new Error('room_unavailable')
  }

  async list(tenantId: string): Promise<Booking[]> {
    return this.db.tenantTx(tenantId, async (x) =>
      (await x.query("SELECT * FROM bookings WHERE tenant_id = $1 AND status = 'confirmed' ORDER BY created_at, ref", [tenantId])).map(rowToBooking),
    )
  }
}
