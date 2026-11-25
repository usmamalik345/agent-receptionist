/**
 * Platform tools + per-agent allow-lists (least privilege) + the runner that enforces them.
 * The tenant comes from the call's session (ToolContext), never from tool arguments: any
 * `tenant_id`-like argument is rejected. Side-effect tools (bookings) need a confirmation id
 * that the booking agent issued AND the caller confirmed on a later turn.
 */
import { answerHoursQuestion } from '../agents/hoursTool.ts'
import { retrieve } from '../agents/retrieval.ts'
import { runTool } from '../tools.ts'
import type { AgentName, ToolCallRecord } from './protocol.ts'
import { toBusinessConfig } from './tenantAdapter.ts'
import type { BookingStore } from './store.ts'
import { money, type Tenant, type Vertical } from './tenant.ts'

export interface ToolContext {
  tenant: Tenant
  callId: string
  store: BookingStore
  /** confirmation id the caller has confirmed this turn (set by the orchestrator only) */
  confirmedId: string | null
  /** test/eval hook: make a named tool fail */
  failTool?: string | null
}

interface ToolDef {
  name: string
  verticals: Vertical[]
  sideEffect: boolean
  validate(a: Record<string, unknown>): string | null
  run(ctx: ToolContext, a: Record<string, unknown>): unknown
}

const str = (a: Record<string, unknown>, k: string) => (typeof a[k] === 'string' && (a[k] as string).length > 0 && (a[k] as string).length < 200 ? null : `${k}: string required`)
const date = (a: Record<string, unknown>, k: string) => (typeof a[k] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(a[k] as string) ? null : `${k}: YYYY-MM-DD required`)
const all = (...xs: Array<string | null>) => xs.find((x) => x !== null) ?? null

export const TOOLS: Record<string, ToolDef> = {
  get_hours: {
    name: 'get_hours', verticals: ['hotel', 'dental'], sideEffect: false,
    validate: (a) => str(a, 'question'),
    run: (ctx, a) => answerHoursQuestion(ctx.tenant.locations, String(a.question)),
  },
  search_knowledge: {
    name: 'search_knowledge', verticals: ['hotel', 'dental'], sideEffect: false,
    validate: (a) => str(a, 'query'),
    run: (ctx, a) => retrieve(toBusinessConfig(ctx.tenant), String(a.query), { k: 3 }),
  },
  get_prices: {
    name: 'get_prices', verticals: ['hotel', 'dental'], sideEffect: false,
    validate: () => null,
    run: (ctx) =>
      ctx.tenant.hotel
        ? ctx.tenant.hotel.rooms.map((r) => ({ item: r.type, price: r.ratePerNight === null ? null : `${money(ctx.tenant, r.ratePerNight)} per night`, maxGuests: r.maxGuests }))
        : (ctx.tenant.dental?.treatments ?? []).map((t) => ({ item: t.name, price: t.price === null ? null : `from ${money(ctx.tenant, t.price)}` })),
  },
  get_policy: {
    name: 'get_policy', verticals: ['hotel'], sideEffect: false,
    validate: () => null,
    run: (ctx) => ({ checkIn: ctx.tenant.hotel!.checkInTime, checkOut: ctx.tenant.hotel!.checkOutTime, cancellation: ctx.tenant.hotel!.cancellationPolicy }),
  },
  check_availability: {
    name: 'check_availability', verticals: ['dental'], sideEffect: false,
    validate: (a) => all(date(a, 'date'), str(a, 'treatment'), str(a, 'location')),
    run: (ctx, a) => {
      const dur = ctx.tenant.dental!.treatments.find((t) => t.name === a.treatment)?.durationMin
      if (!dur) throw new Error('unknown treatment')
      return ctx.store.appointmentSlots(ctx.tenant, { date: String(a.date), location: String(a.location), durationMin: dur })
    },
  },
  book_appointment: {
    name: 'book_appointment', verticals: ['dental'], sideEffect: true,
    validate: (a) => all(date(a, 'date'), str(a, 'time'), str(a, 'treatment'), str(a, 'location'), str(a, 'name'), str(a, 'phone'), str(a, 'confirmation_id')),
    run: (ctx, a) => ctx.store.createAppointment(ctx.tenant, { date: String(a.date), time: String(a.time), treatment: String(a.treatment), location: String(a.location), name: String(a.name), phone: String(a.phone) }),
  },
  check_room_availability: {
    name: 'check_room_availability', verticals: ['hotel'], sideEffect: false,
    validate: (a) => all(date(a, 'check_in'), date(a, 'check_out'), typeof a.guests === 'number' && a.guests > 0 && a.guests < 20 ? null : 'guests: 1-19'),
    run: (ctx, a) => ctx.store.roomOptions(ctx.tenant, { checkIn: String(a.check_in), checkOut: String(a.check_out), guests: Number(a.guests) }),
  },
  book_room: {
    name: 'book_room', verticals: ['hotel'], sideEffect: true,
    validate: (a) => all(date(a, 'check_in'), date(a, 'check_out'), str(a, 'room_type'), str(a, 'name'), str(a, 'phone'), str(a, 'confirmation_id'), typeof a.guests === 'number' ? null : 'guests: number'),
    run: (ctx, a) => ctx.store.createRoomBooking(ctx.tenant, { checkIn: String(a.check_in), checkOut: String(a.check_out), roomType: String(a.room_type), guests: Number(a.guests), name: String(a.name), phone: String(a.phone) }),
  },
  handoff_to_human: {
    name: 'handoff_to_human', verticals: ['hotel', 'dental'], sideEffect: false,
    validate: (a) => str(a, 'reason'),
    // Local only: records the hand-off request; nothing is sent anywhere.
    run: (ctx, a) => ({ queued: true, reason: String(a.reason), callId: ctx.callId }),
  },
}

/** Least privilege: what each agent may call. Triage and guard call nothing. */
export const ALLOW: Record<AgentName, ReadonlySet<string>> = {
  orchestrator: new Set(['handoff_to_human']),
  triage: new Set(),
  faq: new Set(['get_hours', 'search_knowledge', 'get_prices', 'get_policy']),
  booking: new Set(['check_availability', 'book_appointment', 'check_room_availability', 'book_room', 'get_prices']),
  guard: new Set(),
  human: new Set(),
}

export type ToolOutcome<T = unknown> = { ok: true; result: T; record: ToolCallRecord } | { ok: false; error: string; record: ToolCallRecord }

export async function callTool<T = unknown>(agent: AgentName, name: string, args: Record<string, unknown>, ctx: ToolContext, timeoutMs = 2000): Promise<ToolOutcome<T>> {
  const t0 = performance.now()
  const fail = (error: string): ToolOutcome<T> => ({ ok: false, error, record: { agent, tool: name, ok: false, error, ms: Math.round(performance.now() - t0) } })
  const def = TOOLS[name]
  if (!def) return fail('unknown_tool')
  if (!ALLOW[agent].has(name)) return fail('tool_not_allowed')
  if (!def.verticals.includes(ctx.tenant.vertical)) return fail('tool_not_for_vertical')
  if (Object.keys(args).some((k) => /tenant|business/i.test(k))) return fail('cross_tenant_arg')
  const bad = def.validate(args)
  if (bad) return fail(`schema_error: ${bad}`)
  if (def.sideEffect && (!ctx.confirmedId || args.confirmation_id !== ctx.confirmedId)) return fail('confirmation_required')
  const r = await runTool(name, async () => {
    if (ctx.failTool === name) throw new Error('injected_failure')
    return def.run(ctx, args)
  }, args, { timeoutMs })
  if (!r.ok) return fail(r.error ?? 'tool_error')
  return { ok: true, result: r.result as T, record: { agent, tool: name, ok: true, ms: r.ms } }
}
