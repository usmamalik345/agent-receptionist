import { ARABIC_GREETING, ENGLISH_GREETING } from '../config/resort'
import { getActiveBusiness } from './businessRuntime'
import { sanitizeForSpeech } from './speakSanitize'
import type { Language } from './types'

const GREETING_AUDIO: Partial<Record<Language, string>> = {
  en: '/audio/greeting-en.wav',
  ar: '/audio/greeting-ar.mp3',
}

const greetingAudioByLang: Partial<Record<Language, HTMLAudioElement>> = {}
let audioUnlocked = false
/** Active neural TTS clips (Arabic fallback) — cancelled by stopSpeaking */
let neuralPlayers: HTMLAudioElement[] = []
let neuralAbort = false

function stopNeuralAudio(): void {
  neuralAbort = true
  for (const a of neuralPlayers) {
    try {
      a.pause()
      a.removeAttribute('src')
      a.load()
    } catch {
      /* ignore */
    }
  }
  neuralPlayers = []
}

function greetingAudioUrl(language: Language): string | null {
  return GREETING_AUDIO[language] ?? null
}

function getGreetingAudio(language: Language): HTMLAudioElement | null {
  const url = greetingAudioUrl(language)
  if (!url || typeof window === 'undefined') return null
  if (greetingAudioByLang[language]) return greetingAudioByLang[language]!
  const audio = new Audio(url)
  audio.preload = 'auto'
  greetingAudioByLang[language] = audio
  return audio
}

/** Must run on pointer-down (before any await) so post-ring play() works in Chrome. */
export function unlockAudioPlayback(): void {
  // Unlock both greeting clips — Arabic was silent when only EN was primed
  for (const lang of ['en', 'ar'] as Language[]) {
    const audio = getGreetingAudio(lang)
    if (!audio) continue
    audio.currentTime = 0
    const attempt = audio.play()
    if (!attempt) continue
    attempt
      .then(() => {
        audio.pause()
        audio.currentTime = 0
        audioUnlocked = true
      })
      .catch(() => {
        /* first visit may need explicit click — retry on full click */
      })
  }
}

/** Pre-recorded greeting — reliable after missed-call ring delay. Resolves when clip ends. */
export function playGreetingAudio(language: Language = 'en'): Promise<boolean> {
  return new Promise((resolve) => {
    const audio = getGreetingAudio(language)
    if (!audio) {
      resolve(false)
      return
    }
    let settled = false
    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      audio.onended = null
      audio.onerror = null
      resolve(ok)
    }
    audio.onended = () => finish(true)
    audio.onerror = () => finish(false)
    audio.currentTime = 0
    const play = audio.play()
    if (!play) {
      finish(false)
      return
    }
    play.catch(() => finish(false))
    setTimeout(() => {
      if (!settled) finish(Boolean(audio.ended || audio.currentTime > 1))
    }, 18000)
  })
}

export function isGreetingAudioPlaying(): boolean {
  return Object.values(greetingAudioByLang).some((a) => a && !a.paused && !a.ended)
}

export async function waitForVoiceIdle(maxMs = 12000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    const synth = getSynth()
    const synthBusy = Boolean(synth?.speaking || synth?.pending)
    const audioBusy = isGreetingAudioPlaying()
    if (!synthBusy && !audioBusy) return
    await new Promise((r) => setTimeout(r, 120))
  }
}

/** Resolve TTS locale — never force EN locale onto Arabic speech. */
function resolveVoiceLocale(language: Language, override?: string): string | undefined {
  if (language === 'ar') return override?.toLowerCase().startsWith('ar') ? override : 'ar-SA'
  return override || getActiveBusiness().voiceLocale || 'en-US'
}

/** Greeting after missed-call ring: file first (reliable), browser TTS fallback. */
export async function speakGreeting(language: Language = 'en'): Promise<void> {
  const biz = getActiveBusiness()
  // Hotel keeps pre-recorded clips; other industries use TTS with configured locale
  if (biz.industry === 'hotel') {
    const url = greetingAudioUrl(language)
    if (url) {
      if (!audioUnlocked) unlockAudioPlayback()
      const played = await playGreetingAudio(language)
      if (played) return
    }
  }
  const text =
    language === 'ar'
      ? biz.greetings.ar || ARABIC_GREETING
      : biz.greetings.en || ENGLISH_GREETING
  await speakText(text, language, {
    skipCancel: true,
    retry: true,
    voiceLocale: resolveVoiceLocale(language, language === 'ar' ? 'ar-SA' : biz.voiceLocale),
  })
}

export type SpeakOptions = {
  /** Avoid cancel() before speak — fixes Chrome silent first line after warmup/ring */
  skipCancel?: boolean
  /** Retry once if the engine never actually starts speaking */
  retry?: boolean
  /** Override BCP-47 voice locale (e.g. en-GB for dental) */
  voiceLocale?: string
}

let voiceWait: Promise<SpeechSynthesisVoice[]> | null = null

function getSynth(): SpeechSynthesis | null {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return null
  return window.speechSynthesis
}

/** Wait until Chrome exposes voices (often empty on first page load). */
export function waitForVoices(timeoutMs = 1200): Promise<SpeechSynthesisVoice[]> {
  const synth = getSynth()
  if (!synth) return Promise.resolve([])
  const existing = synth.getVoices()
  if (existing.length > 0) {
    return Promise.resolve(existing)
  }
  if (voiceWait) return voiceWait

  voiceWait = new Promise((resolve) => {
    const finish = () => {
      const v = synth.getVoices()
      voiceWait = null
      resolve(v)
    }
    const timer = setTimeout(finish, timeoutMs)
    const onChange = () => {
      clearTimeout(timer)
      synth.removeEventListener('voiceschanged', onChange)
      finish()
    }
    synth.addEventListener('voiceschanged', onChange)
    // Some builds populate on resume
    try {
      synth.resume()
    } catch {
      /* ignore */
    }
  })
  return voiceWait
}

/** Call on pointer-down / click (before any await) so Chrome unlocks TTS. */
export function warmupTts(): void {
  const synth = getSynth()
  if (!synth) return
  void synth.getVoices()
  try {
    synth.resume()
  } catch {
    /* ignore */
  }
  void waitForVoices(600)
}

export function preloadVoices(): void {
  void waitForVoices(1500)
}

function pickVoice(
  language: Language,
  voices: SpeechSynthesisVoice[],
  voiceLocale?: string,
): SpeechSynthesisVoice | null {
  const prefer = resolveVoiceLocale(language, voiceLocale) || (language === 'ar' ? 'ar-SA' : 'en-US')
  if (language === 'ar') {
    return (
      voices.find((v) => v.lang.toLowerCase() === 'ar-sa') ||
      voices.find((v) => v.lang.toLowerCase() === 'ar-ae') ||
      voices.find((v) => v.lang.toLowerCase().startsWith('ar')) ||
      voices.find((v) => /arabic|naayf|hoda|salma|zahra/i.test(v.name)) ||
      null
    )
  }
  return (
    voices.find((v) => v.lang.toLowerCase() === prefer.toLowerCase()) ||
    voices.find((v) => v.lang.toLowerCase().startsWith(prefer.slice(0, 2).toLowerCase() + '-')) ||
    voices.find((v) =>
      prefer.startsWith('en-GB')
        ? /en-GB|Google UK|Daniel|UK English/i.test(v.lang + v.name)
        : v.lang.startsWith('en-GB') ||
          v.lang.startsWith('en-US') ||
          /Google UK|Daniel|Microsoft (David|Zira|Mark)|English/i.test(v.name),
    ) ||
    voices.find((v) => v.lang.startsWith('en')) ||
    null
  )
}

function speakOnce(
  synth: SpeechSynthesis,
  text: string,
  language: Language,
  voices: SpeechSynthesisVoice[],
  voiceLocale?: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    let resumeTimer: ReturnType<typeof setInterval> | undefined
    let safetyTimer: ReturnType<typeof setTimeout> | undefined
    let started = false

    const done = (heard: boolean) => {
      if (settled) return
      settled = true
      if (resumeTimer) clearInterval(resumeTimer)
      if (safetyTimer) clearTimeout(safetyTimer)
      resolve(heard)
    }

    const utter = new SpeechSynthesisUtterance(text)
    utter.lang = voiceLocale || (language === 'ar' ? 'ar-SA' : 'en-US')
    utter.rate = language === 'ar' ? 0.9 : 0.95
    utter.pitch = 1
    utter.volume = 1
    const preferred = pickVoice(language, voices, voiceLocale)
    if (preferred) utter.voice = preferred

    utter.onstart = () => {
      started = true
    }
    utter.onend = () => done(started)
    utter.onerror = () => done(false)

    resumeTimer = setInterval(() => {
      if (synth.speaking && synth.paused) {
        try {
          synth.resume()
        } catch {
          /* ignore */
        }
      }
    }, 150)

    try {
      synth.resume()
      synth.speak(utter)
    } catch {
      done(false)
      return
    }

    // Chrome sometimes queues but stays paused
    setTimeout(() => {
      if (!settled && synth.paused) {
        try {
          synth.resume()
        } catch {
          /* ignore */
        }
      }
    }, 80)

    // If never started, resolve quickly so caller can retry once (Arabic engines are slower)
    setTimeout(
      () => {
        if (!settled && !started && !synth.speaking && !synth.pending) {
          done(false)
        }
      },
      language === 'ar' ? 900 : 450,
    )

    safetyTimer = setTimeout(
      () => done(started),
      Math.min(90000, (language === 'ar' ? 8000 : 6000) + text.length * 85),
    )
  })
}

/** True when the browser exposes at least one Arabic TTS voice. */
export function hasArabicTtsVoice(): boolean {
  const synth = getSynth()
  if (!synth) return false
  const voices = synth.getVoices()
  return voices.some((v) => v.lang.toLowerCase().startsWith('ar') || /arabic/i.test(v.name))
}

/** Split long Arabic into ~220-char chunks on punctuation / spaces. */
function chunkForTts(text: string, maxLen = 220): string[] {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= maxLen) return [clean]
  const parts: string[] = []
  let rest = clean
  while (rest.length > maxLen) {
    let cut = -1
    for (const sep of ['۔', '؟', '!', '?', '،', ',', '؛', ';', ' ', ' و']) {
      const idx = rest.lastIndexOf(sep, maxLen)
      if (idx > 40) {
        cut = idx + (sep === ' ' ? 0 : sep.length)
        break
      }
    }
    if (cut < 40) cut = maxLen
    parts.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) parts.push(rest)
  return parts.filter(Boolean)
}

function playAudioUrl(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (neuralAbort) {
      resolve(false)
      return
    }
    const audio = new Audio(url)
    neuralPlayers.push(audio)
    let settled = false
    const done = (ok: boolean) => {
      if (settled) return
      settled = true
      neuralPlayers = neuralPlayers.filter((a) => a !== audio)
      resolve(ok)
    }
    audio.onended = () => done(true)
    audio.onerror = () => done(false)
    const p = audio.play()
    if (!p) {
      done(false)
      return
    }
    p.catch(() => done(false))
  })
}

/**
 * Arabic neural TTS via local /api/tts (edge-tts).
 * Used when Windows has no Arabic voice pack — which is the common case.
 */
export async function speakArabicNeural(text: string): Promise<boolean> {
  const clean = sanitizeForSpeech(text).trim()
  if (!clean) return false
  neuralAbort = false
  const chunks = chunkForTts(clean)
  let any = false
  for (const chunk of chunks) {
    if (neuralAbort) break
    const url = `/api/tts?lang=ar&q=${encodeURIComponent(chunk)}`
    const ok = await playAudioUrl(url)
    if (ok) any = true
    else {
      // One failure — try remaining chunks anyway once
      const retry = await playAudioUrl(url)
      if (retry) any = true
    }
  }
  return any
}

/** Browser TTS — resilient to Chrome silent-first-utterance / paused bugs. */
export async function speakText(
  text: string,
  language: Language = 'en',
  options: SpeakOptions = {},
): Promise<void> {
  const clean = sanitizeForSpeech(text)
  if (!clean.trim()) return

  // Arabic: prefer neural TTS — this PC (and most demo laptops) has no ar voice pack
  if (language === 'ar') {
    stopNeuralAudio()
    neuralAbort = false
    const neuralOk = await speakArabicNeural(clean)
    if (neuralOk) return
    // fall through to browser TTS if API offline
  }

  const synth = getSynth()
  if (!synth) return

  const voices = await waitForVoices()
  // Erth business voiceLocale is en-US — must not override Arabic turns
  const voiceLocale = resolveVoiceLocale(language, options.voiceLocale)

  if (!options.skipCancel && (synth.speaking || synth.pending)) {
    try {
      synth.cancel()
      await new Promise((r) => setTimeout(r, 120))
    } catch {
      /* ignore */
    }
  }

  try {
    synth.resume()
  } catch {
    /* ignore */
  }

  const heard = await speakOnce(synth, clean, language, voices, voiceLocale)

  // Retry ONLY if first attempt never started (Chrome silent queue bug) — not after normal onend
  if (options.retry && !heard) {
    await new Promise((r) => setTimeout(r, 100))
    try {
      synth.resume()
    } catch {
      /* ignore */
    }
    // Second try: drop voice pick constraints if Arabic had no matching voice
    await speakOnce(synth, clean, language, voices, language === 'ar' ? 'ar-SA' : voiceLocale)
  }
}

export function stopSpeaking(): void {
  stopNeuralAudio()
  const synth = getSynth()
  if (!synth) return
  try {
    synth.cancel()
  } catch {
    /* ignore */
  }
}

export type SpeechRecognitionLike = {
  continuous: boolean
  interimResults: boolean
  lang: string
  maxAlternatives?: number
  start: () => void
  stop: () => void
  abort: () => void
  onresult: ((ev: SpeechRecognitionEventLike) => void) | null
  onerror: ((ev: { error: string }) => void) | null
  onend: (() => void) | null
  onstart: (() => void) | null
}

type SpeechRecognitionEventLike = {
  resultIndex: number
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal?: boolean; length: number }> & {
    length: number
  }
}

export function getSpeechRecognition(): SpeechRecognitionLike | null {
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike
    webkitSpeechRecognition?: new () => SpeechRecognitionLike
  }
  const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition
  if (!Ctor) return null
  return new Ctor()
}

export function readRecognitionText(ev: {
  resultIndex: number
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal?: boolean; length: number }> & {
    length: number
  }
}): { finalText: string; interimText: string } {
  let finalText = ''
  let interimText = ''
  for (let i = ev.resultIndex; i < ev.results.length; i++) {
    const row = ev.results[i]
    const piece = row?.[0]?.transcript || ''
    if ((row as { isFinal?: boolean }).isFinal) finalText += piece
    else interimText += piece
  }
  return { finalText: finalText.trim(), interimText: interimText.trim() }
}

/** Full utterance so far (all finals + latest interim) — use with continuous recognition. */
export function readFullTranscript(ev: {
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal?: boolean; length: number }> & {
    length: number
  }
}): string {
  const finals: string[] = []
  let interim = ''
  for (let i = 0; i < ev.results.length; i++) {
    const row = ev.results[i]
    const piece = (row?.[0]?.transcript || '').trim()
    if (!piece) continue
    if ((row as { isFinal?: boolean }).isFinal) finals.push(piece)
    else interim = piece
  }
  return [...finals, interim].filter(Boolean).join(' ').trim()
}

export function hasLiveSpeech(): boolean {
  return typeof window !== 'undefined' && !!getSpeechRecognition() && 'speechSynthesis' in window
}

export function isMockMode(): boolean {
  const key = import.meta.env.VITE_OPENAI_API_KEY
  return !key || key === 'your_key_here'
}

export function sampleScriptLines(
  language: Language,
): Array<{ speaker: 'AI' | 'Guest'; text: string; delayMs: number }> {
  const biz = getActiveBusiness()
  if (biz.sampleCall) {
    const lines = language === 'ar' ? biz.sampleCall.ar || biz.sampleCall.en : biz.sampleCall.en
    if (lines?.length) {
      return lines.map((l) => ({
        speaker: l.speaker === 'Caller' ? 'Guest' : (l.speaker as 'AI' | 'Guest'),
        text: l.text,
        delayMs: l.delayMs,
      }))
    }
  }
  if (language === 'ar') {
    return [
      { speaker: 'AI', text: biz.greetings.ar || ARABIC_GREETING, delayMs: 0 },
      {
        speaker: 'Guest',
        text: 'أريد غرفة لشخصين بالغين وطفل، من 10 إلى 13 أكتوبر 2026، وتسجيل وصول متأخر بعد العاشرة مساءً. اسمي أحمد المنصوري، ورقمي +971 50 555 5555.',
        delayMs: 5500,
      },
      {
        speaker: 'AI',
        text: 'يسعدني المساعدة. ملخص الحجز: أحمد المنصوري، 2 بالغين و 1 طفل، غرفة واحدة، من 10 أكتوبر إلى 13 أكتوبر 2026، هاتف +971 50 555 5555، ملاحظات: تسجيل وصول متأخر بعد الساعة 10 مساءً. هل تؤكدون لإشعار مكتب الحجوزات؟',
        delayMs: 7500,
      },
      { speaker: 'Guest', text: 'نعم، من فضلك.', delayMs: 4800 },
      {
        speaker: 'AI',
        text: 'تم إشعار مكتب الحجوزات. سيتواصلون لتأكيد التوفر والسعر. يمكنني أيضاً إرسال التفاصيل عبر واتساب إن رغبتم. هل تحتاجون شيئاً آخر؟',
        delayMs: 2800,
      },
    ]
  }

  return [
    { speaker: 'AI', text: biz.greetings.en || ENGLISH_GREETING, delayMs: 0 },
    {
      speaker: 'Guest',
      text: 'Hi, I’d like a room for 2 adults and 1 child, check-in 2026-10-10, check-out 2026-10-13, late check-in after 10pm. Name is Ahmed Al Mansoori, phone +971 50 555 5555.',
      delayMs: 5200,
    },
    {
      speaker: 'AI',
      text: 'May I confirm: Ahmed Al Mansoori, 2 adults and 1 child, 1 room, 10 Oct 2026 to 13 Oct 2026, phone +971 50 555 5555, special requests: Late check-in after 10pm. Shall I notify the reservations desk to confirm availability and rate?',
      delayMs: 7000,
    },
    { speaker: 'Guest', text: 'Yes, please.', delayMs: 4500 },
    {
      speaker: 'AI',
      text: 'I’ve notified the reservations desk by WhatsApp. They will call you back to confirm availability and rate. Is there anything else I can help with today?',
      delayMs: 2500,
    },
  ]
}

