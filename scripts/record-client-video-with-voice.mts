/**
 * Record MM Dental Care client video WITH British voice.
 * Pre-generates edge-tts audio, then records UI timed to those clips, then muxes.
 * Output: recordings/mm-dental-client-demo-voice.mp4 (+ overwrites mm-dental-client-demo.mp4)
 */
import { chromium } from 'playwright'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setActiveBusiness } from '../src/lib/businessRuntime.ts'
import { greet, processGuestMessage } from '../src/lib/stateMachine.ts'
import { sanitizeForSpeech } from '../src/lib/speakSanitize.ts'
import { emptyBooking, type BookingFields, type ConversationStep } from '../src/lib/types.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const BASE = process.env.BASE_URL || 'http://127.0.0.1:5173'
const OUT_DIR = path.join(ROOT, 'recordings')
const WORK = path.join(OUT_DIR, '_voice_work')
const OUT_MP4 = path.join(OUT_DIR, 'mm-dental-client-demo-voice.mp4')

const EDGE_TTS_DEFAULT =
  'C:\\Users\\USER\\AppData\\Local\\Programs\\Python\\Python313\\Scripts\\edge-tts.exe'
const FFMPEG_DEFAULT =
  'C:\\Users\\USER\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.0.1-full_build\\bin\\ffmpeg.exe'

const VOICE_AI = 'en-GB-SoniaNeural'
const VOICE_CALLER = 'en-GB-RyanNeural'

type Line = { speaker: 'AI' | 'Caller' | 'Narrator'; text: string }
type UiAction =
  | { type: 'chapter'; id: string; banner: string }
  | { type: 'reset'; afterHours: boolean }
  | { type: 'start' }
  | { type: 'greet' }
  | { type: 'send'; text: string }
  | { type: 'hold'; ms: number }
  | { type: 'film'; on: boolean }
  | { type: 'done' }

type Beat = { line?: Line; ui: UiAction[]; waitExtraMs?: number }

function which(cmd: string): string | null {
  const r = spawnSync('where.exe', [cmd], { encoding: 'utf8' })
  const line = r.stdout?.split(/\r?\n/).map((s) => s.trim()).find(Boolean)
  return line && fs.existsSync(line) ? line : null
}

function findEdge(): string {
  if (process.env.EDGE_TTS && fs.existsSync(process.env.EDGE_TTS)) return process.env.EDGE_TTS
  if (fs.existsSync(EDGE_TTS_DEFAULT)) return EDGE_TTS_DEFAULT
  const w = which('edge-tts')
  if (!w) throw new Error('edge-tts not found')
  return w
}

function findFfmpeg(): string {
  if (process.env.FFMPEG && fs.existsSync(process.env.FFMPEG)) return process.env.FFMPEG
  if (fs.existsSync(FFMPEG_DEFAULT)) return FFMPEG_DEFAULT
  const w = which('ffmpeg')
  if (!w) throw new Error('ffmpeg not found')
  return w
}

function tts(edge: string, text: string, voice: string, out: string) {
  const clean = sanitizeForSpeech(text)
  execFileSync(edge, ['--voice', voice, '--text', clean, '--write-media', out], { stdio: 'pipe' })
}

function durationMs(ffmpeg: string, file: string): number {
  const r = spawnSync(ffmpeg, ['-i', file, '-f', 'null', '-'], { encoding: 'utf8' })
  const err = `${r.stderr || ''}`
  const m = err.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
  if (!m) return 2000
  return Math.ceil((Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000)
}

function silence(ffmpeg: string, ms: number, out: string) {
  execFileSync(
    ffmpeg,
    ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', String(Math.max(0.05, ms / 1000)), '-q:a', '9', out],
    { stdio: 'pipe' },
  )
}

function simSend(
  text: string,
  step: ConversationStep,
  booking: BookingFields,
  afterHours: boolean,
): { reply: string; step: ConversationStep; booking: BookingFields } {
  const r = processGuestMessage({
    text,
    step,
    booking,
    language: 'en',
    afterHours,
    humanTakeover: false,
  })
  return {
    reply: r.text,
    step: r.nextStep,
    booking: { ...booking, ...r.bookingUpdates },
  }
}

/** Build the full spoken + UI script using the real dental engine. */
function buildBeats(): Beat[] {
  setActiveBusiness('mm-dental')
  const beats: Beat[] = []

  beats.push({
    line: {
      speaker: 'Narrator',
      text: 'MM Dental Care. AI receptionist demo for the practice team.',
    },
    ui: [{ type: 'film', on: true }, { type: 'reset', afterHours: false }],
    waitExtraMs: 300,
  })

  // 1 Emergency
  beats.push({
    ui: [
      {
        type: 'chapter',
        id: 'emergency',
        banner: '1 · Same-day emergency — toothache → fee → URGENT + WhatsApp',
      },
      { type: 'hold', ms: 700 },
      { type: 'start' },
    ],
  })
  let g = greet('en', false)
  let step = g.nextStep
  let booking = { ...emptyBooking('en'), ...g.bookingUpdates }
  beats.push({
    line: { speaker: 'AI', text: g.text },
    ui: [{ type: 'greet' }],
  })

  const c1 =
    "Hi, I've got really bad toothache, can I get seen today? Uppingham Road. Name James Patel, phone 07700 900123, new patient."
  beats.push({
    line: { speaker: 'Caller', text: c1 },
    ui: [{ type: 'send', text: c1 }],
    waitExtraMs: 200,
  })
  let s = simSend(c1, step, booking, false)
  step = s.step
  booking = s.booking
  beats.push({ line: { speaker: 'AI', text: s.reply }, ui: [] })
  if (/shall i send|just to confirm/i.test(s.reply)) {
    s = simSend('Yes please', step, booking, false)
    step = s.step
    booking = s.booking
    beats.push({
      line: { speaker: 'AI', text: s.reply },
      ui: [{ type: 'send', text: 'Yes please' }],
    })
  }
  beats.push({ ui: [{ type: 'hold', ms: 900 }] })

  // 2 Membership
  beats.push({
    ui: [
      { type: 'chapter', id: 'membership', banner: '2 · Membership & fees — only verified prices' },
      { type: 'hold', ms: 500 },
      { type: 'start' },
      { type: 'greet' },
    ],
  })
  g = greet('en', false)
  step = g.nextStep
  booking = emptyBooking('en')
  for (const q of ['Do you do membership plans?', 'How much is an emergency appointment?']) {
    beats.push({
      line: { speaker: 'Caller', text: q },
      ui: [{ type: 'send', text: q }],
    })
    s = simSend(q, step, booking, false)
    step = s.step
    booking = s.booking
    beats.push({ line: { speaker: 'AI', text: s.reply }, ui: [] })
  }
  beats.push({ ui: [{ type: 'hold', ms: 700 }] })

  // 3 Hours
  beats.push({
    ui: [{ type: 'chapter', id: 'hours', banner: '3 · Saturday hours — both practices' }, { type: 'hold', ms: 400 }],
  })
  {
    const q = 'What time are you open on Saturday?'
    beats.push({ line: { speaker: 'Caller', text: q }, ui: [{ type: 'send', text: q }] })
    s = simSend(q, 'await_intent', emptyBooking('en'), false)
    beats.push({ line: { speaker: 'AI', text: s.reply }, ui: [] })
  }
  beats.push({ ui: [{ type: 'hold', ms: 700 }] })

  // 4 Reschedule
  beats.push({
    ui: [
      {
        type: 'chapter',
        id: 'reschedule',
        banner: '4 · Move appointment — callback only, no live diary change',
      },
      { type: 'hold', ms: 400 },
    ],
  })
  {
    const q = 'I need to move my appointment on Thursday. Name Alex Reed, phone 07700 900999'
    beats.push({ line: { speaker: 'Caller', text: q }, ui: [{ type: 'send', text: q }] })
    s = simSend(q, 'await_intent', emptyBooking('en'), false)
    beats.push({ line: { speaker: 'AI', text: s.reply }, ui: [] })
  }
  beats.push({ ui: [{ type: 'hold', ms: 800 }] })

  // 5 After hours
  beats.push({
    ui: [
      {
        type: 'chapter',
        id: 'afterhours',
        banner: '5 · After-hours emergency — URGENT callback at opening',
      },
      { type: 'hold', ms: 500 },
      { type: 'reset', afterHours: true },
      { type: 'start' },
    ],
  })
  g = greet('en', true)
  step = g.nextStep
  booking = { ...emptyBooking('en'), ...g.bookingUpdates }
  beats.push({ line: { speaker: 'AI', text: g.text }, ui: [{ type: 'greet' }] })
  {
    const q =
      "It's 9pm — my filling fell out and it's killing me. Name Sarah Khan, phone 07700 900456, existing patient, Uppingham Road."
    beats.push({ line: { speaker: 'Caller', text: q }, ui: [{ type: 'send', text: q }] })
    s = simSend(q, step, booking, true)
    step = s.step
    booking = s.booking
    beats.push({ line: { speaker: 'AI', text: s.reply }, ui: [] })
    if (/shall i send|just to confirm/i.test(s.reply)) {
      s = simSend('Yes please', step, booking, true)
      beats.push({
        line: { speaker: 'AI', text: s.reply },
        ui: [{ type: 'send', text: 'Yes please' }],
      })
    }
  }

  beats.push({
    line: {
      speaker: 'Narrator',
      text: 'Demo complete. Appointment requests go to the practice team, with WhatsApp desk alerts and an urgent queue for dental emergencies.',
    },
    ui: [{ type: 'done' }, { type: 'chapter', id: 'done', banner: 'Demo complete — AI receptionist for MM Dental Care' }],
    waitExtraMs: 400,
  })
  beats.push({ ui: [{ type: 'hold', ms: 1600 }] })

  return beats
}

async function main() {
  const edge = findEdge()
  const ffmpeg = findFfmpeg()
  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.rmSync(WORK, { recursive: true, force: true })
  fs.mkdirSync(WORK, { recursive: true })

  console.log('Building script from dental engine…')
  const beats = buildBeats()

  console.log('Generating British voices (edge-tts)…')
  type Clip = { file: string; ms: number; beatIndex: number }
  const clips: Clip[] = []
  let i = 0
  for (let bi = 0; bi < beats.length; bi++) {
    const b = beats[bi]
    if (!b.line) {
      const hold = b.ui.find((u) => u.type === 'hold')
      const ms = hold && hold.type === 'hold' ? hold.ms : 0
      if (ms > 0) {
        const file = path.join(WORK, `sil-${String(i++).padStart(3, '0')}.mp3`)
        silence(ffmpeg, ms, file)
        clips.push({ file, ms, beatIndex: bi })
      }
      continue
    }
    const voice =
      b.line.speaker === 'Caller' ? VOICE_CALLER : VOICE_AI
    const file = path.join(WORK, `line-${String(i++).padStart(3, '0')}.mp3`)
    console.log(`  [${b.line.speaker}] ${b.line.text.slice(0, 70)}…`)
    tts(edge, b.line.text, voice, file)
    const ms = durationMs(ffmpeg, file) + (b.waitExtraMs || 180)
    clips.push({ file, ms, beatIndex: bi })
  }

  // Map beat -> clip duration (sum if multiple — one clip per beat with line or hold)
  const beatMs = new Map<number, number>()
  for (const c of clips) beatMs.set(c.beatIndex, (beatMs.get(c.beatIndex) || 0) + c.ms)

  console.log('Recording UI timed to voice…')
  const browser = await chromium.launch({
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required'],
  })
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    recordVideo: { dir: WORK, size: { width: 1400, height: 900 } },
  })
  const page = await context.newPage()
  await page.addInitScript(() => {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.speak = ((u: SpeechSynthesisUtterance) => {
        setTimeout(() => {
          u.onstart?.(new Event('start') as SpeechSynthesisEvent)
          u.onend?.(new Event('end') as SpeechSynthesisEvent)
        }, 15)
      }) as typeof speechSynthesis.speak
      Object.defineProperty(window.speechSynthesis, 'speaking', { get: () => false })
      Object.defineProperty(window.speechSynthesis, 'pending', { get: () => false })
    }
  })

  await page.goto(`${BASE}/record-demo?biz=mm-dental`, { waitUntil: 'networkidle', timeout: 60000 })
  await page.waitForFunction(() => Boolean((window as unknown as { __mmDentalDrive?: unknown }).__mmDentalDrive), {
    timeout: 20000,
  })

  type Drive = {
    reset: () => void
    setAfterHours: (on: boolean) => void
    start: () => void
    greet: () => string
    send: (text: string) => string
    setFilm: (on: boolean) => void
    setChapter: (id: string, banner: string) => void
  }

  const runUi = async (actions: UiAction[]) => {
    for (const a of actions) {
      if (a.type === 'film') {
        await page.evaluate((on) => (window as unknown as { __mmDentalDrive: Drive }).__mmDentalDrive.setFilm(on), a.on)
      } else if (a.type === 'reset') {
        await page.evaluate(() => (window as unknown as { __mmDentalDrive: Drive }).__mmDentalDrive.reset())
        await page.evaluate(
          (on) => (window as unknown as { __mmDentalDrive: Drive }).__mmDentalDrive.setAfterHours(on),
          a.afterHours,
        )
      } else if (a.type === 'start') {
        await page.evaluate(() => (window as unknown as { __mmDentalDrive: Drive }).__mmDentalDrive.start())
      } else if (a.type === 'greet') {
        await page.evaluate(() => (window as unknown as { __mmDentalDrive: Drive }).__mmDentalDrive.greet())
      } else if (a.type === 'send') {
        await page.evaluate(
          (t) => (window as unknown as { __mmDentalDrive: Drive }).__mmDentalDrive.send(t),
          a.text,
        )
      } else if (a.type === 'chapter') {
        await page.evaluate(
          (p) => (window as unknown as { __mmDentalDrive: Drive }).__mmDentalDrive.setChapter(p.id, p.banner),
          { id: a.id, banner: a.banner },
        )
      } else if (a.type === 'done') {
        await page.evaluate(() =>
          (window as unknown as { __mmDentalDrive: Drive }).__mmDentalDrive.setChapter(
            'done',
            'Demo complete — AI receptionist for MM Dental Care',
          ),
        )
      } else if (a.type === 'hold') {
        // timing handled by beat wait
      }
    }
  }

  for (let bi = 0; bi < beats.length; bi++) {
    const b = beats[bi]
    // For caller lines: start waiting a bit then fire send so bubble appears while voice plays
    const hasCaller = b.line?.speaker === 'Caller'
    const sendAction = b.ui.find((u) => u.type === 'send')
    const otherUi = b.ui.filter((u) => u.type !== 'send' && u.type !== 'hold')
    await runUi(otherUi)

    const ms = beatMs.get(bi) || (b.ui.find((u) => u.type === 'hold') as { ms: number } | undefined)?.ms || 400

    if (hasCaller && sendAction && sendAction.type === 'send') {
      const pre = Math.min(600, Math.floor(ms * 0.25))
      await page.waitForTimeout(pre)
      await page.evaluate(
        (t) => (window as unknown as { __mmDentalDrive: Drive }).__mmDentalDrive.send(t),
        sendAction.text,
      )
      await page.waitForTimeout(Math.max(100, ms - pre))
    } else {
      // AI replies / narrator: UI for greet already done; send confirms already in ui
      const confirmSend = b.ui.find((u) => u.type === 'send')
      if (confirmSend && confirmSend.type === 'send' && !hasCaller) {
        await page.evaluate(
          (t) => (window as unknown as { __mmDentalDrive: Drive }).__mmDentalDrive.send(t),
          confirmSend.text,
        )
      }
      await page.waitForTimeout(ms)
    }
  }

  const video = page.video()
  await context.close()
  await browser.close()
  if (!video) throw new Error('No video')
  const videoPath = await video.path()
  const rawVideo = path.join(WORK, 'raw.webm')
  fs.renameSync(videoPath, rawVideo)

  console.log('Concat voice track…')
  const listFile = path.join(WORK, 'list.txt')
  // Windows ffmpeg concat needs forward slashes or escaped paths
  fs.writeFileSync(
    listFile,
    clips.map((c) => `file '${c.file.replace(/\\/g, '/')}'`).join('\n'),
    'utf8',
  )
  const audioPath = path.join(WORK, 'voice.mp3')
  execFileSync(ffmpeg, ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', audioPath], {
    stdio: 'pipe',
  })

  console.log('Muxing…')
  execFileSync(
    ffmpeg,
    [
      '-y',
      '-i',
      rawVideo,
      '-i',
      audioPath,
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-shortest',
      '-movflags',
      '+faststart',
      OUT_MP4,
    ],
    { stdio: 'pipe' },
  )

  const also = path.join(OUT_DIR, 'mm-dental-client-demo.mp4')
  fs.copyFileSync(OUT_MP4, also)
  const stat = fs.statSync(OUT_MP4)
  console.log('SAVED', OUT_MP4)
  console.log('ALSO', also)
  console.log('SIZE_MB', (stat.size / (1024 * 1024)).toFixed(2))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
