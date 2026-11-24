/**
 * Make replies sound like a person on the phone, not a form: contractions, no lists or
 * markdown, short sentences (one TTS chunk each, so the first sentence can be spoken
 * while the rest is synthesised), and a short acknowledgement in the tenant's persona
 * style. Text only - it never changes facts (numbers, times, prices are left as they are).
 */
import type { VoicePersona } from './tenant.ts'

const CONTRACTIONS: Array<[RegExp, string]> = [
  [/\bI am\b/g, "I'm"], [/\bI will\b/g, "I'll"], [/\bI would\b/g, "I'd"], [/\bI have\b(?= (got|booked|passed|sent|noted|found))/g, "I've"],
  [/\bwe are\b/gi, "we're"], [/\bwe will\b/gi, "we'll"], [/\bwe have\b(?= (got|booked|passed|sent))/gi, "we've"],
  [/\byou are\b/gi, "you're"], [/\byou will\b/gi, "you'll"], [/\bit is\b/gi, "it's"], [/\bthat is\b/gi, "that's"],
  [/\bthere is\b/gi, "there's"], [/\bdo not\b/gi, "don't"], [/\bdoes not\b/gi, "doesn't"], [/\bcannot\b/gi, "can't"],
  [/\bcan not\b/gi, "can't"], [/\bis not\b/gi, "isn't"], [/\bare not\b/gi, "aren't"], [/\bwill not\b/gi, "won't"],
  [/\blet us\b/gi, "let's"],
]

const ACKS: Record<VoicePersona['style'], string[]> = {
  warm: ['Of course.', 'Sure.', 'No problem.'],
  calm: ['Sure.', 'Okay.', 'Right.'],
  upbeat: ['Great.', 'Lovely.', 'Sure thing.'],
}

const keepCase = (src: string, rep: string) => (src[0] === src[0].toUpperCase() ? rep[0].toUpperCase() + rep.slice(1) : rep)

export function humanize(text: string): string {
  let t = text
    .replace(/[*_#`>]+/g, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/\s*\n+\s*/g, '. ')
    .replace(/\.\s*\./g, '.')
    .replace(/\s{2,}/g, ' ')
    .trim()
  for (const [re, rep] of CONTRACTIONS) t = t.replace(re, (m) => keepCase(m, rep))
  return t
}

/** Sentence chunks for streaming TTS (first chunk goes to TTS first). Long sentences split at commas. */
export function sentences(text: string, maxChars = 140): string[] {
  const out: string[] = []
  for (const s of text.split(/(?<=[.!?])\s+(?=[A-Z0-9£$"'])/)) {
    if (s.length <= maxChars) { if (s.trim()) out.push(s.trim()); continue }
    let cur = ''
    for (const part of s.split(/(?<=,)\s+/)) {
      if ((cur + ' ' + part).trim().length > maxChars && cur) { out.push(cur.trim()); cur = part } else cur = `${cur} ${part}`
    }
    if (cur.trim()) out.push(cur.trim())
  }
  return out
}

/** Short acknowledgement before an answer, rotated by turn so it does not repeat every time. */
export function acknowledgement(style: VoicePersona['style'], turn: number): string {
  const a = ACKS[style] ?? ACKS.warm
  return a[turn % a.length]
}

/** Naturalise a list of items for speech: "a, b and c". */
export function spokenList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}
