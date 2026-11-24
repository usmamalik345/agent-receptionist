import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import { platform, type TurnResult } from './engine'

export type CallState = ReturnType<typeof platform.callState>
export interface Turn { id: string; say: string; at: number; ms?: number; result?: TurnResult; error?: string }
export interface Call {
  id: string
  tenantId: string
  startedAt: number
  greeting: string
  turns: Turn[]
  state: CallState
  label?: string
  busy: boolean
}
export type Status = 'live' | 'booked' | 'handed' | 'screened' | 'answered'
export function statusOf(c: Call): Status {
  const rs = c.turns.map((t) => t.result).filter(Boolean) as TurnResult[]
  if (rs.some((r) => r.booking)) return 'booked'
  if (rs.some((r) => r.escalated)) return 'handed'
  if (rs.some((r) => r.injection.length || r.guard.blocked)) return 'screened'
  if (c.busy || c.state.bookingActive) return 'live'
  return 'answered'
}

interface Ctx {
  calls: Call[]
  startCall(tenantId: string, label?: string): Call
  send(callId: string, text: string): Promise<TurnResult | null>
  runScript(tenantId: string, lines: string[], label: string, gapMs?: number): Promise<string>
  version: number
}
const C = createContext<Ctx | null>(null)
const uid = () => globalThis.crypto.randomUUID()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function ConsoleState({ children }: { children: ReactNode }) {
  const [calls, setCalls] = useState<Call[]>([])
  const [version, setVersion] = useState(0)
  const ref = useRef<Call[]>([])
  const update = useCallback((id: string, f: (c: Call) => Call) => {
    ref.current = ref.current.map((c) => (c.id === id ? f(c) : c))
    setCalls(ref.current)
  }, [])

  const startCall = useCallback((tenantId: string, label?: string): Call => {
    const s = platform.start(tenantId)
    const call: Call = { id: s.callId, tenantId, startedAt: Date.now(), greeting: s.greeting, turns: [], state: platform.callState(tenantId, s.callId), label, busy: false }
    ref.current = [call, ...ref.current]
    setCalls(ref.current)
    return call
  }, [])

  const send = useCallback(async (callId: string, text: string) => {
    const call = ref.current.find((c) => c.id === callId)
    if (!call) return null
    const turn: Turn = { id: uid(), say: text, at: Date.now() }
    update(callId, (c) => ({ ...c, busy: true, turns: [...c.turns, turn] }))
    const t0 = performance.now()
    try {
      const r = await platform.turn(call.tenantId, callId, text)
      const ms = performance.now() - t0
      update(callId, (c) => ({ ...c, busy: false, state: platform.callState(c.tenantId, c.id), turns: c.turns.map((x) => (x.id === turn.id ? { ...x, ms, result: r } : x)) }))
      if (r.booking) setVersion((v) => v + 1)
      return r
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      update(callId, (c) => ({ ...c, busy: false, turns: c.turns.map((x) => (x.id === turn.id ? { ...x, error: msg } : x)) }))
      return null
    }
  }, [update])

  const runScript = useCallback(async (tenantId: string, lines: string[], label: string, gapMs = 250) => {
    const c = startCall(tenantId, label)
    for (const line of lines) { await sleep(gapMs); await send(c.id, line) }
    return c.id
  }, [startCall, send])

  const v = useMemo(() => ({ calls, startCall, send, runScript, version }), [calls, startCall, send, runScript, version])
  return <C.Provider value={v}>{children}</C.Provider>
}

export function useConsole(): Ctx {
  const c = useContext(C)
  if (!c) throw new Error('ConsoleState missing')
  return c
}

export type Theme = 'light' | 'dark'
export function initialTheme(): Theme {
  const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('sb-theme') : null
  if (saved === 'light' || saved === 'dark') return saved
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}
