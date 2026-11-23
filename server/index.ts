/**
 * Free-first WhatsApp bridge for missed-call desk alerts.
 * Providers (auto-pick): CallMeBot (free) → Meta Cloud API (free test) → Twilio (optional paid).
 * Also: /api/tts Arabic neural speech via edge-tts (Windows often has no ar voice pack).
 */
import 'dotenv/config'
import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { mkdir, readFile, writeFile, access } from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import cors from 'cors'
import express from 'express'
import twilio from 'twilio'
import { mountAgentRoutes } from './agentRoutes.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TTS_CACHE_DIR = path.join(__dirname, '..', '.tts-cache')
const AR_VOICE = process.env.TTS_AR_VOICE || 'ar-SA-ZariyahNeural'
const EN_VOICE = process.env.TTS_EN_VOICE || 'en-US-JennyNeural'

const PORT = Number(process.env.PORT || 8787)
const {
  // CallMeBot — free personal WhatsApp (recommended in Pakistan)
  CALLMEBOT_APIKEY = '',
  CALLMEBOT_PHONE = '',
  // Meta WhatsApp Cloud API — free test number (developers.facebook.com)
  META_WA_TOKEN = '',
  META_WA_PHONE_NUMBER_ID = '',
  META_WA_TO = '',
  // Twilio — optional
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_WHATSAPP_FROM = 'whatsapp:+14155238886',
  DESK_WHATSAPP_TO = '',
  TWILIO_VOICE_NUMBER = '',
  WA_PROVIDER = 'auto', // auto | callmebot | meta | twilio
} = process.env

const app = express()
app.use(cors())
app.use(express.json())
app.use(express.urlencoded({ extended: false }))

function digitsOnly(addr: string): string {
  return addr.replace(/[^\d]/g, '')
}

function toE164(addr: string): string {
  const raw = addr.trim()
  if (!raw) return ''
  if (raw.startsWith('whatsapp:')) return raw.slice('whatsapp:'.length)
  const d = raw.replace(/[^\d+]/g, '')
  return d.startsWith('+') ? d : `+${d}`
}

function toWhatsApp(addr: string): string {
  const e164 = toE164(addr)
  return e164 ? `whatsapp:${e164}` : ''
}

type Provider = 'callmebot' | 'meta' | 'twilio'

function callmebotReady() {
  return Boolean(CALLMEBOT_APIKEY && (CALLMEBOT_PHONE || DESK_WHATSAPP_TO))
}
function metaReady() {
  return Boolean(META_WA_TOKEN && META_WA_PHONE_NUMBER_ID && (META_WA_TO || DESK_WHATSAPP_TO))
}
function twilioReady() {
  return Boolean(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && DESK_WHATSAPP_TO)
}

function pickProvider(): Provider | null {
  const forced = WA_PROVIDER.toLowerCase()
  if (forced === 'callmebot') return callmebotReady() ? 'callmebot' : null
  if (forced === 'meta') return metaReady() ? 'meta' : null
  if (forced === 'twilio') return twilioReady() ? 'twilio' : null
  // auto: free first
  if (callmebotReady()) return 'callmebot'
  if (metaReady()) return 'meta'
  if (twilioReady()) return 'twilio'
  return null
}

function buildMissedBody(input: {
  guestName: string
  phone: string
  checkIn: string
  checkOut: string
  adults?: number
  children?: number
  specialRequests?: string
}): string {
  const guests =
    input.adults != null || input.children != null
      ? `${input.adults ?? 0} adults / ${input.children ?? 0} children`
      : 'guest count TBD'
  return [
    'Erth · Missed desk pickup → AI captured inquiry',
    `Guest: ${input.guestName}`,
    `Phone: ${input.phone}`,
    `Stay: ${input.checkIn} → ${input.checkOut}`,
    `Party: ${guests}`,
    input.specialRequests ? `Notes: ${input.specialRequests}` : null,
    'Please call back to confirm availability/rate. (DEMO · no Opera write)',
  ]
    .filter(Boolean)
    .join('\n')
}

async function sendCallMeBot(toPhone: string, text: string) {
  const phone = digitsOnly(toPhone)
  const url = new URL('https://api.callmebot.com/whatsapp.php')
  url.searchParams.set('phone', phone)
  url.searchParams.set('text', text)
  url.searchParams.set('apikey', CALLMEBOT_APIKEY)
  const res = await fetch(url.toString())
  const raw = await res.text()
  if (!res.ok) {
    throw new Error(`CallMeBot HTTP ${res.status}: ${raw.slice(0, 200)}`)
  }
  // CallMeBot often returns 200 with an error string in body
  if (/error|invalid|not activated|apikey/i.test(raw) && !/success|queued|sent|message/i.test(raw)) {
    throw new Error(raw.slice(0, 240))
  }
  return { sid: `callmebot-${Date.now()}`, status: 'sent', providerResponse: raw.slice(0, 200) }
}

type MetaFields = {
  guestName?: string
  checkIn?: string
  checkOut?: string
  party?: string
  roomOrNotes?: string
}

async function metaPost(
  url: string,
  headers: Record<string, string>,
  payload: Record<string, unknown>,
) {
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  })
  const data = (await res.json()) as {
    messages?: { id: string }[]
    error?: { message: string; code?: number }
  }
  return { res, data }
}

/**
 * Prefer free-form text while the 24h customer-care window is open
 * (user must have messaged the Test Number chat recently — e.g. "ok").
 * Outside that window, Meta rejects free-form; fall back to Erth utility
 * template, then hello_world buzz only.
 */
async function sendMeta(toPhone: string, text: string, fields: MetaFields = {}) {
  const to = digitsOnly(toPhone)
  const url = `https://graph.facebook.com/v21.0/${META_WA_PHONE_NUMBER_ID}/messages`
  const headers = {
    Authorization: `Bearer ${META_WA_TOKEN}`,
    'Content-Type': 'application/json',
  }

  const guest = (fields.guestName || 'Guest').slice(0, 60)
  const stay =
    fields.checkIn && fields.checkOut
      ? `${fields.checkIn} → ${fields.checkOut}`.slice(0, 60)
      : (fields.checkIn || 'dates TBD').slice(0, 60)
  const party = (fields.party || 'party TBD').slice(0, 60)
  const room = (fields.roomOrNotes || 'see dashboard').slice(0, 60)

  // 1) Free-form Erth body (what you want on the phone for the Hany demo)
  {
    const { res, data } = await metaPost(url, headers, {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text.slice(0, 4000), preview_url: false },
    })
    if (res.ok && !data.error) {
      return {
        sid: data.messages?.[0]?.id || `meta-${Date.now()}`,
        status: 'accepted',
        mode: 'text' as const,
      }
    }
  }

  // 2) Custom Erth utility template (PENDING until Meta approves)
  {
    const { res, data } = await metaPost(url, headers, {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: 'erth_desk_inquiry_v1',
        language: { code: 'en' },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: guest },
              { type: 'text', text: stay },
              { type: 'text', text: party },
              { type: 'text', text: room },
            ],
          },
        ],
      },
    })
    if (res.ok && !data.error) {
      return {
        sid: data.messages?.[0]?.id || `meta-erth-${Date.now()}`,
        status: 'accepted',
        mode: 'erth_desk_inquiry_v1' as const,
        note: 'Outside 24h window — sent via Erth desk template.',
      }
    }
  }

  // 3) Last resort: hello_world buzz (no grocery/order templates — those look wrong for a hotel demo)
  const { res: tplRes, data: tplData } = await metaPost(url, headers, {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: { name: 'hello_world', language: { code: 'en_US' } },
  })
  if (!tplRes.ok || tplData.error) {
    throw new Error(
      tplData.error?.message ||
        `Meta API failed. Generate a NEW access token in Meta Step 1, paste into META_WA_TOKEN, reply "ok" on WhatsApp, retry.`,
    )
  }
  return {
    sid: tplData.messages?.[0]?.id || `meta-tpl-${Date.now()}`,
    status: 'accepted',
    mode: 'hello_world_template' as const,
    note: 'Free-form blocked (no open 24h session). Reply "ok" in the Test Number chat, then retry for full Erth text.',
  }
}

async function sendTwilio(toPhone: string, text: string) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) throw new Error('Twilio credentials missing')
  const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
  const msg = await client.messages.create({
    from: TWILIO_WHATSAPP_FROM,
    to: toWhatsApp(toPhone),
    body: text,
  })
  return { sid: msg.sid, status: msg.status || 'queued' }
}

app.get('/api/health', (_req, res) => {
  const provider = pickProvider()
  res.json({
    ok: true,
    provider: provider || null,
    readyToSend: Boolean(provider),
    providers: {
      callmebot: callmebotReady(),
      meta: metaReady(),
      twilio: twilioReady(),
    },
    deskWhatsAppSet: Boolean(DESK_WHATSAPP_TO || CALLMEBOT_PHONE || META_WA_TO),
    tip: provider
      ? `Ready via ${provider} — Missed call → AI or Send test WhatsApp`
      : 'Free path: set CALLMEBOT_APIKEY + CALLMEBOT_PHONE in .env (see /api/setup). No Twilio needed.',
    voiceNumber: TWILIO_VOICE_NUMBER || null,
  })
})

app.get('/api/setup', (_req, res) => {
  res.json({
    recommended: 'callmebot',
    callmebot: [
      '1. Open https://www.callmebot.com/blog/free-api-whatsapp-messages/',
      '2. Add the bot number shown there to WhatsApp contacts',
      '3. Send: I allow callmebot to send me messages',
      '4. Bot replies with your APIKEY (free, personal use — to YOUR number only)',
      '5. .env → CALLMEBOT_APIKEY=...  CALLMEBOT_PHONE=+92XXXXXXXXXX',
      '6. npm run dev:all → Dashboard → Send test WhatsApp',
    ],
    meta: [
      '1. https://developers.facebook.com → Create app → Add WhatsApp',
      '2. API Setup: copy Temporary token + Phone number ID (free test number)',
      '3. Add your WhatsApp under To (verify code) — up to 5 numbers, free',
      '4. Send hello_world template once from the dashboard, reply on phone',
      '5. .env → META_WA_TOKEN=... META_WA_PHONE_NUMBER_ID=... META_WA_TO=+92...',
    ],
    twilio: ['Optional / paid — skip if blocked in Pakistan'],
  })
})

app.post('/api/missed-call', async (req, res) => {
  const {
    guestName = 'Guest',
    phone = '-',
    checkIn = '-',
    checkOut = '-',
    adults,
    children,
    specialRequests = '',
    to,
  } = req.body ?? {}

  const provider = pickProvider()
  const overrideTo = String(to || '').trim()
  const defaultTo =
    provider === 'callmebot'
      ? CALLMEBOT_PHONE || DESK_WHATSAPP_TO
      : provider === 'meta'
        ? META_WA_TO || DESK_WHATSAPP_TO
        : DESK_WHATSAPP_TO

  const dest = toE164(overrideTo || defaultTo || '')
  if (!dest) {
    res.status(400).json({
      ok: false,
      error: 'Set CALLMEBOT_PHONE (or DESK_WHATSAPP_TO / META_WA_TO) or pass body.to',
    })
    return
  }

  const body = buildMissedBody({
    guestName: String(guestName),
    phone: String(phone),
    checkIn: String(checkIn),
    checkOut: String(checkOut),
    adults: adults != null ? Number(adults) : undefined,
    children: children != null ? Number(children) : undefined,
    specialRequests: specialRequests ? String(specialRequests) : undefined,
  })

  if (!provider) {
    res.status(503).json({
      ok: false,
      error: 'No free WhatsApp provider configured',
      hint: 'Easiest: CallMeBot — get free APIKEY, set CALLMEBOT_APIKEY + CALLMEBOT_PHONE in .env. See /api/setup',
      preview: { to: dest, body },
    })
    return
  }

  try {
    let result: {
      sid: string
      status: string
      providerResponse?: string
      mode?: string
      note?: string
      previewBody?: string
    }
    const partyLabel =
      adults != null || children != null
        ? `${Number(adults) || 0} adults / ${Number(children) || 0} children`
        : undefined
    if (provider === 'callmebot') result = await sendCallMeBot(dest, body)
    else if (provider === 'meta')
      result = await sendMeta(dest, body, {
        guestName: String(guestName),
        checkIn: String(checkIn),
        checkOut: String(checkOut),
        party: partyLabel,
        roomOrNotes: specialRequests ? String(specialRequests) : undefined,
      })
    else result = await sendTwilio(dest, body)

    res.json({
      ok: true,
      provider,
      sid: result.sid,
      status: result.status,
      mode: result.mode,
      note: result.note,
      to: dest,
      body,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(502).json({
      ok: false,
      provider,
      error: message,
      to: dest,
      hint:
        provider === 'callmebot'
          ? 'Re-activate CallMeBot (send allow message) and check APIKEY + phone match WhatsApp.'
          : provider === 'meta'
            ? 'Add number in Meta API Setup → send hello_world → reply once, then retry free-form text.'
            : 'Check Twilio sandbox join / credentials.',
    })
  }
})

/** Twilio voice optional — only if you later add a number */
app.post('/api/twilio/voice', async (req, res) => {
  const from = String(req.body?.From || 'unknown')
  const caller = from.replace(/^whatsapp:/, '')
  const provider = pickProvider()
  if (provider) {
    const text = [
      'Erth · Live missed / after-hours call on voice line',
      `Caller: ${caller}`,
      'AI / IVR answered — please follow up. (DEMO)',
    ].join('\n')
    const dest = toE164(CALLMEBOT_PHONE || META_WA_TO || DESK_WHATSAPP_TO)
    void (async () => {
      try {
        if (provider === 'callmebot' && dest) await sendCallMeBot(dest, text)
        else if (provider === 'meta' && dest) await sendMeta(dest, text)
        else if (provider === 'twilio' && dest) await sendTwilio(dest, text)
      } catch (e) {
        console.error('[voice→whatsapp]', e)
      }
    })()
  }

  const vr = new twilio.twiml.VoiceResponse()
  vr.say(
    { voice: 'Polly.Joanna' },
    'Thank you for calling Erth Abu Dhabi reservations. Our desk is currently unavailable. An inquiry alert has been sent to the team on WhatsApp. Please leave your name and number after the tone, or call back during business hours.',
  )
  vr.record({ maxLength: 60, playBeep: true, transcribe: false })
  vr.say('Thank you. Goodbye.')
  vr.hangup()
  res.type('text/xml').send(vr.toString())
})

/** Neural TTS — Arabic-first (edge-tts). Cached on disk by text hash. */
app.get('/api/tts', async (req, res) => {
  const text = String(req.query.q || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 500)
  const lang = String(req.query.lang || 'ar').toLowerCase().startsWith('ar') ? 'ar' : 'en'
  if (!text) {
    res.status(400).json({ ok: false, error: 'missing q' })
    return
  }

  const voice = lang === 'ar' ? AR_VOICE : EN_VOICE
  const key = createHash('sha1').update(`${voice}|${text}`).digest('hex')
  const outFile = path.join(TTS_CACHE_DIR, `${key}.mp3`)

  try {
    await mkdir(TTS_CACHE_DIR, { recursive: true })
    let buf: Buffer
    try {
      await access(outFile)
      buf = await readFile(outFile)
    } catch {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          'python',
          ['-m', 'edge_tts', '-t', text, '-v', voice, '--write-media', outFile],
          { stdio: ['ignore', 'ignore', 'pipe'] },
        )
        let err = ''
        child.stderr?.on('data', (d: Buffer) => {
          err += d.toString()
        })
        child.on('error', reject)
        child.on('exit', (code) => {
          if (code === 0) resolve()
          else reject(new Error(err.trim() || `edge_tts exit ${code}`))
        })
      })
      buf = await readFile(outFile)
    }

    res.setHeader('Content-Type', 'audio/mpeg')
    res.setHeader('Cache-Control', 'public, max-age=86400')
    res.setHeader('X-TTS-Voice', voice)
    res.send(buf)
  } catch (e) {
    console.error('[tts]', e)
    res.status(502).json({
      ok: false,
      error: e instanceof Error ? e.message : 'tts failed',
      hint: 'Install edge-tts: pip install edge-tts',
    })
  }
})

/** Traced agent pipeline + browser trace ingest (local, no outbound messages) */
mountAgentRoutes(app)

app.listen(PORT, () => {
  const provider = pickProvider()
  console.log(`[erth-bridge] http://localhost:${PORT}`)
  console.log(`[erth-bridge] provider=${provider || 'none'} (free-first: callmebot → meta → twilio)`)
  console.log(`[erth-bridge] Arabic TTS voice=${AR_VOICE}`)
})
