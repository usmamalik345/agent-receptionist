/**
 * Shared shapes for industry presets + per-business configs.
 * Industry preset supplies defaults; business config overrides.
 */

export type IndustryId = 'hotel' | 'dental' | 'clinic' | 'restaurant'

export type DayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'

export interface LocationHours {
  mon: string
  tue: string
  wed: string
  thu: string
  fri: string
  sat: string
  sun: string
}

export interface BusinessLocation {
  name: string
  address: string
  phone: string
  hours: LocationHours
  notes?: string
}

export interface ServiceItem {
  name: string
  priceNote?: string
}

export interface PricingItem {
  item: string
  price: string
}

export interface FaqItem {
  q: string
  a: string
  /** Optional keyword matcher; if omitted, matched loosely from q */
  keywords?: RegExp
}

export interface DemoChip {
  label: string
  text: string
}

export interface EscalationRules {
  humanPhrases: string[]
  modifyAsCallback: boolean
  inventPrices: false
}

export interface EmergencyConfig {
  enabled: boolean
  message: string
  fee?: string
  /** Safety line — never omit for dental */
  severeAdvice?: string
}

export interface IndustryWording {
  bookingNoun: string
  bookingNounPlural: string
  customerNoun: string
  customerNounPlural: string
  teamNoun: string
  deskNoun: string
  /** e.g. "diary" for dental, "availability" for hotel */
  scheduleNoun: string
  confirmVerb: string
  /** British vs Gulf English hints */
  localeStyle: 'en-GB' | 'en-AE' | 'en-US'
}

export interface IndustryPreset {
  id: IndustryId
  wording: IndustryWording
  /** Ordered booking field ids the collect flow should gather */
  bookingFields: string[]
  intents: string[]
  staffQueueLabels: {
    title: string
    claim: string
    done: string
    open: string
    urgent: string
  }
  demoChips: DemoChip[]
  /** Default voice BCP-47 for TTS sample */
  voiceLocale: string
}

export interface BusinessConfig {
  slug: string
  industry: IndustryId
  name: string
  greetingName: string
  locale: string
  languages: Array<'en' | 'ar'>
  timezone: string
  locations: BusinessLocation[]
  afterHoursMessage: string
  services: ServiceItem[]
  /** Only verified prices — never invent beyond this list */
  pricing: PricingItem[]
  faqs: FaqItem[]
  bookingFields: string[]
  escalationRules: EscalationRules
  emergency: EmergencyConfig
  brandColor: string
  logoText: string
  /**
   * Fake / demo desk number for UI only (WhatsApp panel header).
   * Never put a real practice line here for client demos.
   */
  deskDisplayPhone?: string
  about?: string
  tagline?: string
  propertyLabel?: string
  demoBadge?: string
  greetings: {
    en: string
    enAfterHours?: string
    ar?: string
    arAfterHours?: string
  }
  demoChips: {
    en: DemoChip[]
    ar?: DemoChip[]
  }
  voiceLocale: string
  /** Hotel-only extras kept for Erth parity */
  hotelExtras?: {
    checkInTime: string
    checkOutTime: string
    frontDeskOpens: string
    frontDeskCloses: string
    reservationsPhone: string
    phone: string
    emailDesk: string
    whatsappDesk: string
    website: string
    seller: { name: string; role: string; market: string }
  }
  /** Optional scripted sample-call lines (voice demo) */
  sampleCall?: {
    en: Array<{ speaker: 'AI' | 'Guest' | 'Caller'; text: string; delayMs: number }>
    ar?: Array<{ speaker: 'AI' | 'Guest' | 'Caller'; text: string; delayMs: number }>
  }
}

/** Merge industry preset defaults with a partial business override. */
export function mergeBusiness(
  preset: IndustryPreset,
  partial: Omit<BusinessConfig, 'bookingFields' | 'demoChips' | 'voiceLocale'> & {
    bookingFields?: string[]
    demoChips?: BusinessConfig['demoChips']
    voiceLocale?: string
  },
): BusinessConfig {
  return {
    ...partial,
    bookingFields: partial.bookingFields ?? preset.bookingFields,
    demoChips: partial.demoChips ?? { en: preset.demoChips },
    voiceLocale: partial.voiceLocale ?? preset.voiceLocale,
  }
}
