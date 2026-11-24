/**
 * Picks the most natural-sounding browser voice that is actually installed.
 * Free only: Edge exposes Microsoft "Online (Natural)" neural voices, Chrome exposes
 * "Google ..." voices, Safari/macOS has "Premium"/"Enhanced" voices. Older SAPI voices
 * (David, Zira, Mark desktop) and eSpeak sound robotic, so they rank last.
 * Pure function (no DOM) so it is unit-tested in node.
 */
export interface VoiceLike {
  name: string
  lang: string
  localService?: boolean
}

export function scoreVoice(v: VoiceLike, locale: string, preferred: string[] = []): number {
  const name = v.name
  const lang = v.lang.toLowerCase().replace('_', '-')
  const want = locale.toLowerCase()
  let s = 0
  const pi = preferred.findIndex((p) => p.toLowerCase() === name.toLowerCase())
  if (pi >= 0) s += 1000 - pi * 10
  if (lang === want) s += 120
  else if (lang.slice(0, 2) === want.slice(0, 2)) s += 40
  else return -1000 // never speak English text with a non-English voice
  if (/\bnatural\b/i.test(name)) s += 300
  if (/\bonline\b/i.test(name)) s += 60
  if (/neural/i.test(name)) s += 250
  if (/\b(premium|enhanced)\b/i.test(name)) s += 220
  if (/^google\b/i.test(name)) s += 150
  if (/espeak|\bdesktop\b|microsoft (david|zira|mark|hazel|george|susan)\b(?!.*natural)/i.test(name)) s -= 150
  return s
}

export function pickBestVoice<T extends VoiceLike>(voices: T[], locale: string, preferred: string[] = []): T | null {
  let best: T | null = null
  let bestScore = -Infinity
  for (const v of voices) {
    const sc = scoreVoice(v, locale, preferred)
    if (sc > bestScore) { best = v; bestScore = sc }
  }
  return bestScore > -1000 ? best : null
}

/** Neural voices already speak at a natural pace; old voices sound better slightly slower. */
export function naturalRate(v: VoiceLike | null, base = 1): number {
  if (!v) return 0.95 * base
  return /natural|neural|premium|enhanced|^google/i.test(v.name) ? 1.0 * base : 0.92 * base
}

/** Sentence chunks so the first sentence starts playing at once and short pauses fall between sentences. */
export function speechChunks(text: string, max = 160): string[] {
  const out: string[] = []
  for (const s of text.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/)) {
    if (!s) continue
    if (s.length <= max) out.push(s)
    else {
      let cur = ''
      for (const part of s.split(/(?<=[,;:])\s+/)) {
        if (cur && (cur + ' ' + part).length > max) { out.push(cur); cur = part } else cur = cur ? `${cur} ${part}` : part
      }
      if (cur) out.push(cur)
    }
  }
  return out
}
