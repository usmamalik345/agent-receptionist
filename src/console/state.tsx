import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { platform, type TurnResult } from './engine'

export interface Msg {
  id: string
  role: 'user' | 'bot'
  text: string
  at: number
  result?: TurnResult
}
export interface Call {
  id: string
  tenantId: string
  startedAt: number
  messages: Msg[]
  status: 'active' | 'booked' | 'escalated'
}

interface Ctx {
  calls: Call[]
  startCall(tenantId: string): Call
  send(call: Call, text: string): Promise<TurnResult | { error: string }>
  bookingsVersion: number
}
const C = createContext<Ctx | null>(null)
const uid = () => globalThis.crypto.randomUUID()

export function ConsoleState({ children }: { children: ReactNode }) {
  const [calls, setCalls] = useState<Call[]>([])
  const [bookingsVersion, setBV] = useState(0)

  const startCall = useCallback((tenantId: string): Call => {
    const s = platform.start(tenantId)
    const call: Call = { id: s.callId, tenantId, startedAt: Date.now(), status: 'active', messages: [{ id: uid(), role: 'bot', text: s.greeting, at: Date.now() }] }
    setCalls((cs) => [call, ...cs])
    return call
  }, [])

  const send = useCallback(async (call: Call, text: string) => {
    const user: Msg = { id: uid(), role: 'user', text, at: Date.now() }
    setCalls((cs) => cs.map((c) => (c.id === call.id ? { ...c, messages: [...c.messages, user] } : c)))
    try {
      const r = await platform.turn(call.tenantId, call.id, text)
      const bot: Msg = { id: uid(), role: 'bot', text: r.text, at: Date.now(), result: r }
      setCalls((cs) => cs.map((c) => (c.id === call.id ? { ...c, messages: [...c.messages, bot], status: r.booking ? 'booked' : r.escalated ? 'escalated' : c.status } : c)))
      if (r.booking) setBV((v) => v + 1)
      return r
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const bot: Msg = { id: uid(), role: 'bot', text: `Something went wrong (${msg}). Please try again.`, at: Date.now() }
      setCalls((cs) => cs.map((c) => (c.id === call.id ? { ...c, messages: [...c.messages, bot] } : c)))
      return { error: msg }
    }
  }, [])

  const v = useMemo(() => ({ calls, startCall, send, bookingsVersion }), [calls, startCall, send, bookingsVersion])
  return <C.Provider value={v}>{children}</C.Provider>
}

export function useConsole(): Ctx {
  const c = useContext(C)
  if (!c) throw new Error('ConsoleState missing')
  return c
}

export type Theme = 'light' | 'dark'
export function initialTheme(): Theme {
  const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('cx-theme') : null
  if (saved === 'light' || saved === 'dark') return saved
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}
