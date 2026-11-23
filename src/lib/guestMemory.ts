import type { BookingFields, CallRecord, GuestProfile, Language } from './types'

export function digitsOnlyPhone(phone: string): string {
  return (phone || '').replace(/\D/g, '')
}

/** Match profiles / history by last 9–12 digits (tolerant of +971 / 00971). */
export function phonesMatch(a: string, b: string): boolean {
  const da = digitsOnlyPhone(a)
  const db = digitsOnlyPhone(b)
  if (!da || !db) return false
  if (da === db) return true
  const tail = (s: string) => (s.length > 9 ? s.slice(-9) : s)
  return tail(da) === tail(db) && tail(da).length >= 9
}

export function findGuestProfile(
  profiles: GuestProfile[],
  phone: string,
): GuestProfile | null {
  const d = digitsOnlyPhone(phone)
  if (d.length < 8) return null
  return profiles.find((p) => phonesMatch(p.phoneDigits, d)) ?? null
}

export function findInHistory(history: CallRecord[], phone: string): CallRecord | null {
  if (digitsOnlyPhone(phone).length < 8) return null
  return history.find((h) => phonesMatch(h.booking.phone, phone)) ?? null
}

export function upsertGuestProfile(
  profiles: GuestProfile[],
  booking: BookingFields,
): GuestProfile[] {
  const digits = digitsOnlyPhone(booking.phone)
  if (digits.length < 8 || !booking.guestName) return profiles
  const existing = findGuestProfile(profiles, digits)
  const next: GuestProfile = {
    phoneDigits: digits,
    guestName: booking.guestName,
    language: booking.language || 'en',
    lastCheckIn: booking.checkIn || existing?.lastCheckIn || '',
    lastCheckOut: booking.checkOut || existing?.lastCheckOut || '',
    lastSpecial: booking.specialRequests || existing?.lastSpecial || '',
    roomCategory: booking.roomCategory || existing?.roomCategory || '',
    visitCount: (existing?.visitCount || 0) + 1,
    lastSeenAt: Date.now(),
  }
  const rest = profiles.filter((p) => !phonesMatch(p.phoneDigits, digits))
  return [next, ...rest].slice(0, 40)
}

export function welcomeBackLine(profile: GuestProfile, language: Language): string {
  const stay =
    profile.lastCheckIn && profile.lastCheckOut
      ? language === 'ar'
        ? `آخر طلب إقامة كان من ${profile.lastCheckIn} إلى ${profile.lastCheckOut}`
        : `your last stay inquiry was ${profile.lastCheckIn} to ${profile.lastCheckOut}`
      : language === 'ar'
        ? 'لدينا طلب سابق لكم'
        : 'we have a previous inquiry on file'
  const pref = profile.roomCategory
    ? language === 'ar'
      ? `، تفضيل الغرفة ${profile.roomCategory}`
      : `, preferred ${profile.roomCategory}`
    : ''
  if (language === 'ar') {
    return `أهلاً بعودتكم ${profile.guestName} — ${stay}${pref}. هل هذا طلب جديد أم تعديل؟`
  }
  return `Welcome back, ${profile.guestName} — ${stay}${pref}. Is this a new stay or a change to that inquiry?`
}

export function bookingPrefillFromProfile(profile: GuestProfile): Partial<BookingFields> {
  return {
    guestName: profile.guestName,
    phone: profile.phoneDigits.startsWith('971')
      ? `+${profile.phoneDigits}`
      : profile.phoneDigits,
    language: profile.language,
    roomCategory: profile.roomCategory || '',
    specialRequests: profile.lastSpecial || '',
  }
}
