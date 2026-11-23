/** Browser client for the local Twilio WhatsApp bridge (server/). */

export type BridgeHealth = {
  ok: boolean
  provider?: string | null
  twilioConfigured?: boolean
  deskWhatsAppSet: boolean
  readyToSend: boolean
  providers?: { callmebot?: boolean; meta?: boolean; twilio?: boolean }
  whatsappFrom?: string
  voiceNumber?: string | null
  tip?: string
}

export type MissedCallPayload = {
  guestName?: string
  phone?: string
  checkIn?: string
  checkOut?: string
  adults?: number | null
  children?: number | null
  specialRequests?: string
  /** Override .env DESK_WHATSAPP_TO for a one-off test */
  to?: string
}

export type MissedCallResult = {
  ok: boolean
  provider?: string
  sid?: string
  status?: string
  to?: string
  body?: string
  error?: string
  hint?: string
  preview?: { to: string; body: string }
}

export async function fetchBridgeHealth(): Promise<BridgeHealth> {
  const res = await fetch('/api/health')
  if (!res.ok) {
    throw new Error(`Bridge offline (${res.status}). Run npm run dev:all`)
  }
  return res.json() as Promise<BridgeHealth>
}

export async function sendMissedCallWhatsApp(payload: MissedCallPayload): Promise<MissedCallResult> {
  try {
    const res = await fetch('/api/missed-call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    let data: MissedCallResult
    try {
      data = (await res.json()) as MissedCallResult
    } catch {
      return { ok: false, error: 'offline' }
    }
    if (!res.ok && data.ok !== false) {
      return { ok: false, error: data.error || 'offline' }
    }
    return data
  } catch {
    return { ok: false, error: 'offline' }
  }
}

const LS_KEY = 'erth_desk_whatsapp_override'

export function loadDeskWhatsAppOverride(): string {
  try {
    return localStorage.getItem(LS_KEY) || ''
  } catch {
    return ''
  }
}

export function saveDeskWhatsAppOverride(value: string) {
  try {
    if (value.trim()) localStorage.setItem(LS_KEY, value.trim())
    else localStorage.removeItem(LS_KEY)
  } catch {
    /* ignore */
  }
}
