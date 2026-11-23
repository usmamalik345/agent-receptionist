/**
 * Erth Abu Dhabi — hotel business config.
 * Property facts from erth.ae (DEMO / SAMPLE). All hotel knowledge lives behind this slug.
 */

import {
  ARABIC_GREETING,
  DINING,
  ENGLISH_GREETING,
  EVENTS,
  PRICING as PROPOSAL_PRICING,
  RESORT,
  ROOMS,
  SERVICES,
  WELLNESS,
} from '../config/resort'
import { DEMO_CHIPS } from '../config/knowledge'
import type { BusinessConfig } from '../config/businessTypes'
import { hotelPreset } from '../industries/hotel'

export const erthBusiness: BusinessConfig = {
  slug: 'erth',
  industry: 'hotel',
  name: RESORT.name,
  greetingName: RESORT.name,
  locale: 'en-AE',
  languages: ['en', 'ar'],
  timezone: 'Asia/Dubai',
  locations: [
    {
      name: RESORT.name,
      address: RESORT.address,
      phone: RESORT.reservationsPhone,
      hours: {
        mon: `${RESORT.frontDeskOpens}–${RESORT.frontDeskCloses}`,
        tue: `${RESORT.frontDeskOpens}–${RESORT.frontDeskCloses}`,
        wed: `${RESORT.frontDeskOpens}–${RESORT.frontDeskCloses}`,
        thu: `${RESORT.frontDeskOpens}–${RESORT.frontDeskCloses}`,
        fri: `${RESORT.frontDeskOpens}–${RESORT.frontDeskCloses}`,
        sat: `${RESORT.frontDeskOpens}–${RESORT.frontDeskCloses}`,
        sun: `${RESORT.frontDeskOpens}–${RESORT.frontDeskCloses}`,
      },
      notes: RESORT.location,
    },
  ],
  afterHoursMessage: `I can take your request and notify reservations (${RESORT.reservationsPhone}).`,
  services: [
    { name: 'Butler', priceNote: SERVICES.butler },
    { name: 'Valmont Spa', priceNote: WELLNESS.spa.en },
    { name: 'Etizan Fitness', priceNote: WELLNESS.fitness.en },
    { name: 'Airport transfer', priceNote: SERVICES.airportShuttle },
    { name: 'Kids Club', priceNote: SERVICES.kidsClub },
  ],
  pricing: [],
  faqs: [
    {
      q: 'What time is check-in and check-out?',
      a: `Check-in from ${RESORT.checkInTime}, check-out by ${RESORT.checkOutTime}.`,
      keywords: /check[\s-]?in|check[\s-]?out/i,
    },
    {
      q: 'Where are you located?',
      a: RESORT.location,
      keywords: /where|location|address|dubai\s*marina/i,
    },
  ],
  bookingFields: hotelPreset.bookingFields,
  escalationRules: {
    humanPhrases: ['agent please', 'human', 'talk to someone', 'موظف'],
    modifyAsCallback: true,
    inventPrices: false,
  },
  emergency: {
    enabled: false,
    message: '',
  },
  brandColor: '#0f766e',
  logoText: 'Er',
  about: RESORT.story,
  tagline: RESORT.tagline,
  propertyLabel: RESORT.propertyLabel,
  demoBadge: RESORT.demoBadge,
  greetings: {
    en: ENGLISH_GREETING,
    enAfterHours:
      'Welcome to Erth Abu Dhabi reservations. I’m an AI assistant covering after-hours and overflow. How may I help: a reservation, a change, dining, spa, or a colleague?',
    ar: ARABIC_GREETING,
    arAfterHours:
      'أهلاً بكم في حجوزات إرث أبوظبي. أنا مساعد ذكي للرد خارج أوقات الذروة. كيف يمكنني مساعدتكم: حجز، تعديل، مطعم، سبا، أو التحدث مع زميل؟',
  },
  demoChips: {
    en: [...DEMO_CHIPS.en],
    ar: [...DEMO_CHIPS.ar],
  },
  voiceLocale: 'en-US',
  hotelExtras: {
    checkInTime: RESORT.checkInTime,
    checkOutTime: RESORT.checkOutTime,
    frontDeskOpens: RESORT.frontDeskOpens,
    frontDeskCloses: RESORT.frontDeskCloses,
    reservationsPhone: RESORT.reservationsPhone,
    phone: RESORT.phone,
    emailDesk: RESORT.emailDesk,
    whatsappDesk: RESORT.whatsappDesk,
    website: RESORT.website,
    seller: { ...RESORT.seller },
  },
}

/** Re-exports for hotel engine modules that still import property facts. */
export const erthProperty = {
  RESORT,
  ROOMS,
  DINING,
  SERVICES,
  WELLNESS,
  EVENTS,
  PROPOSAL_PRICING,
}
