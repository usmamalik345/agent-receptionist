/**
 * MM Dental Care (Leicester, UK) — dental business config.
 * Facts from mmdentalcare.co.uk. DEMO / SAMPLE — not an official product.
 */

import type { BusinessConfig } from '../config/businessTypes'
import { dentalPreset } from '../industries/dental'

const EMERGENCY_FEE =
  '£50 consultation + £10 for any X-rays; treatment charged on top.'

export const mmDentalBusiness: BusinessConfig = {
  slug: 'mm-dental',
  industry: 'dental',
  name: 'MM Dental Care',
  greetingName: 'MM Dental Care',
  locale: 'en-GB',
  languages: ['en'],
  timezone: 'Europe/London',
  about:
    'Family-run group of dental practices established since 1946; welcoming to nervous patients and people who haven\'t seen a dentist in a long time.',
  tagline: 'Family-run dental practices · Leicester · since 1946',
  propertyLabel: 'MM Dental Care (Demo)',
  demoBadge: 'DEMO / SAMPLE · facts from mmdentalcare.co.uk',
  locations: [
    {
      name: 'Uppingham Road Practice',
      address: '193 Uppingham Road, Leicester, LE5 4BQ',
      phone: '0116 276 7760',
      hours: {
        mon: '8:30am–5pm',
        tue: '8:30am–7pm',
        wed: '8:30am–7pm',
        thu: '9am–7pm',
        fri: '9am–5pm',
        sat: '9am–12pm',
        sun: 'closed',
      },
    },
    {
      name: 'Upperton Road Practice',
      address: '15 Upperton Road, Leicester, LE3 0BH',
      phone: '0116 247 0431',
      hours: {
        mon: '10:30am–6pm',
        tue: '9am–5pm',
        wed: '9am–6pm',
        thu: '9am–5pm',
        fri: '9am–5pm',
        sat: '9am–12pm phone lines only',
        sun: 'closed',
      },
      // Staff-only note — not spoken (saturdayHours builds one clean caller sentence)
      notes: 'Saturday patients are seen at Uppingham Road; Upperton is phone lines only.',
    },
  ],
  afterHoursMessage:
    "The practice is closed right now, but I can take your details and the team will call you back as soon as we open. If it's a dental emergency, I'll mark it as urgent.",
  services: [
    { name: 'Same-day emergency appointment', priceNote: EMERGENCY_FEE },
    { name: 'Membership plans', priceNote: 'From £13.50 a month' },
    { name: 'Pay as you go', priceNote: 'Available' },
    { name: 'New patient registration' },
    { name: 'General dentistry' },
  ],
  pricing: [
    {
      item: 'Same-day emergency appointment',
      price: '£50 consultation + £10 for any X-rays; treatment charged on top',
    },
    {
      item: 'Membership plans',
      price: 'Start from £13.50 a month; pay-as-you-go also available',
    },
  ],
  faqs: [
    {
      q: 'Do you accept new patients?',
      a: 'Yes, new patients are always welcome.',
      keywords: /new\s*patient|register|sign\s*up|join/i,
    },
    {
      q: 'What payment options do you have?',
      a: 'Pay as you go, or membership plans from £13.50 a month.',
      keywords: /pay(ment| as you go)|membership|plan|monthly|fee/i,
    },
    {
      q: 'Do you offer emergency appointments?',
      a: `Same-day emergency appointments: ${EMERGENCY_FEE}. We aim to get you pain free at the appointment.`,
      keywords: /emergency|toothache|tooth\s*ache|pain|swelling|bleeding|abscess|broken\s*tooth|knocked/i,
    },
    {
      q: 'I am nervous about the dentist',
      a: "That's completely understandable. Our team is used to nervous patients and people who haven't seen a dentist in a long time — we'll look after you at your pace.",
      keywords: /nervous|anxious|scared|afraid|phobia|haven'?t\s*(been|seen)|long\s*time/i,
    },
  ],
  bookingFields: dentalPreset.bookingFields,
  escalationRules: {
    humanPhrases: ['agent please', 'speak to someone', 'human', 'receptionist', 'talk to a person'],
    modifyAsCallback: true,
    inventPrices: false,
  },
  emergency: {
    enabled: true,
    message:
      'We can offer a same-day emergency appointment. The consultation is £50, plus £10 for any X-rays, and treatment is charged on top. We aim to get you pain free at the appointment.',
    fee: EMERGENCY_FEE,
    severeAdvice:
      'If you have severe swelling affecting breathing or swallowing, call 999 or go to A&E.',
  },
  brandColor: '#0d7377',
  logoText: 'MM',
  /** Demo-only — never a real practice line on screen */
  deskDisplayPhone: '020 7946 0123 (demo)',
  greetings: {
    en: "Good morning, you're through to MM Dental Care, how can I help?",
    enAfterHours:
      "You're through to MM Dental Care. The practice is closed right now, but I can take your details and the team will call you back as soon as we open. How can I help?",
  },
  demoChips: {
    en: [
      { label: 'New patient', text: "Hi, I'd like to register as a new patient" },
      { label: 'Toothache today', text: "I've got really bad toothache, can I be seen today?" },
      {
        label: 'After-hours emergency',
        text: "My filling fell out and it's killing me",
      },
      { label: 'Emergency fee', text: 'How much is an emergency appointment?' },
      { label: 'Membership', text: 'Do you do membership plans?' },
      { label: 'Reschedule', text: 'I need to move my appointment on Thursday' },
      { label: 'Saturday hours', text: 'What time are you open on Saturday?' },
      { label: 'Nervous', text: "I'm really nervous about the dentist" },
    ],
  },
  voiceLocale: 'en-GB',
  sampleCall: {
    en: [
      {
        speaker: 'AI',
        text: "Good morning, you're through to MM Dental Care, how can I help?",
        delayMs: 0,
      },
      {
        speaker: 'Caller',
        text: "Hi, I've got really bad toothache, can I get seen today?",
        delayMs: 2800,
      },
      {
        speaker: 'AI',
        text: "I'm sorry you're in pain. We can offer a same-day emergency appointment — £50 consultation plus £10 for any X-rays, treatment on top. Which practice is closer, Uppingham Road or Upperton Road?",
        delayMs: 4500,
      },
      {
        speaker: 'Caller',
        text: "Uppingham Road please. I'm James Patel, new patient, phone 07700 900123.",
        delayMs: 5200,
      },
      {
        speaker: 'AI',
        text: "Thank you James. I've sent this to the team as urgent — they'll confirm your time shortly. If swelling starts affecting your breathing or swallowing, call 999 or go to A&E.",
        delayMs: 4800,
      },
    ],
  },
}
