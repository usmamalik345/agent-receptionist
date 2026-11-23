/**
 * Strip markdown / list symbols so TTS never says "times" / "asterisk" / etc.
 * Turn bullet-like separators into natural spoken pauses.
 */

/** Text the caller / TTS should hear — never markdown, bullets, or "times"-glyphs. */
export function sanitizeForSpeech(raw: string): string {
  if (!raw) return ''
  let t = raw

  // Remove fenced / inline code and markdown emphasis
  t = t.replace(/```[\s\S]*?```/g, ' ')
  t = t.replace(/`([^`]+)`/g, '$1')
  t = t.replace(/\*\*([^*]+)\*\*/g, '$1')
  t = t.replace(/\*([^*]+)\*/g, '$1')
  t = t.replace(/__([^_]+)__/g, '$1')
  t = t.replace(/_([^_]+)_/g, '$1')
  t = t.replace(/^#{1,6}\s+/gm, '')

  // Drop staff-only / channel-internal lines if they leak into spoken text
  t = t.replace(/\bNo live diary change was made from this channel\.?\s*/gi, '')
  t = t.replace(/\bThis isn'?t a live diary booking yet\.?\s*/gi, '')
  t = t.replace(/\bAppointment request \(not a live diary booking\)\.?\s*/gi, '')
  t = t.replace(/\bCHANGE\/CANCEL inquiry only[^.]*\.?\s*/gi, '')
  t = t.replace(/\bfrom this channel\.?\s*/gi, '')

  // Bullet / numbered list lines → clauses
  t = t.replace(/^\s*[-*•·]\s+/gm, '')
  t = t.replace(/^\s*\d+[.)]\s+/gm, '')

  // Middle-dot / bullet / multiply separators (TTS often says "times") → commas
  t = t.replace(/\s*[·•×]\s*/g, ', ')
  // Spaced hyphen/en/em used as list breaks (not inside words like check-up)
  t = t.replace(/\s+[–—]\s+/g, '. ')
  t = t.replace(/\s+-\s+/g, ', ')

  // Collapse leftover symbols TTS misreads
  t = t.replace(/[•·×†‡§¶]/g, ' ')
  t = t.replace(/[*#_~|<>{}[\]\\]/g, ' ')

  // Whitespace + repeated punctuation
  t = t.replace(/\s+/g, ' ').trim()
  t = t.replace(/\s+([,.!?])/g, '$1')
  t = t.replace(/([.!?]){2,}/g, '$1')
  t = t.replace(/,\s*,+/g, ',')
  t = t.replace(/^\s*,\s*/, '')
  t = t.replace(/\.\s*\./g, '.')

  // Ensure sentence-ending punctuation for pacing (if none at end)
  if (t && !/[.!?]$/.test(t)) t = `${t}.`

  // Capitalise after sentence breaks
  t = t.replace(/(^|[.!?]\s+)([a-z])/g, (_, a, b) => a + b.toUpperCase())

  return t
}

/** Spoken booking summary — commas, no list glyphs. */
export function spokenBookingSummary(parts: {
  guestName?: string
  phone?: string
  patientType?: string
  practice?: string
  reason?: string
  preferredDayTime?: string
  emergency?: boolean
}): string {
  const bits: string[] = []
  if (parts.guestName) bits.push(parts.guestName)
  if (parts.phone) bits.push(`phone ${parts.phone}`)
  if (parts.patientType === 'new') bits.push('new patient')
  else if (parts.patientType === 'existing') bits.push('existing patient')
  if (parts.practice) bits.push(parts.practice)
  if (parts.reason) bits.push(parts.reason)
  else if (parts.emergency) bits.push('dental emergency')
  if (parts.emergency) bits.push('marked urgent')
  else if (parts.preferredDayTime) bits.push(`preferred ${parts.preferredDayTime}`)
  if (!bits.length) return 'the details we have so far.'
  return `${bits.join(', ')}.`
}
