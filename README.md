# Multi-industry AI Receptionist Demo

Config-driven demo (Vite + React). Default business is **Erth Abu Dhabi** (hotel). **MM Dental Care** (Leicester, UK) is the first dental business. Facts are labelled **DEMO / SAMPLE**.

## Select a business

```
http://localhost:5173/dashboard              → Erth (default)
http://localhost:5173/dashboard?biz=erth
http://localhost:5173/dashboard?biz=mm-dental
http://localhost:5173/record-demo?biz=mm-dental
```

Unknown `?biz=` shows a picker of registered businesses.

## Install

```bash
npm install
```

## Run locally

```bash
npm run dev
```

## Routes

| URL | Purpose |
|---|---|
| `/dashboard?biz=…` | Screen-share control surface |
| `/whatsapp-demo?biz=…` | Fake WhatsApp UI (same state machine) |
| `/pilot?biz=…` | Printable pilot one-pager |
| `/record-demo?biz=mm-dental` | 60s screen-recordable dental voice demo |
| `/run-of-show` | Meeting checklist (hotel) |
| `/go-live` | Go-live checklist (hotel) |

## Tests

```bash
npm run smoke              # Erth hotel paths
npm run smoke:dental       # MM Dental Care engine + config leak scan
npm run smoke:dental-ui    # Playwright: render ?biz=mm-dental, fail on hotel words
```

For the UI leak test, serve a build first:

```bash
npm run build && npx vite preview --host 127.0.0.1 --port 4173
npm run smoke:dental-ui
```

## Architecture

```
src/industries/     hotel.ts, dental.ts   ← presets (wording, fields, chips)
src/businesses/     erth.ts, mm-dental.ts ← one file per client
src/lib/stateMachine.ts                   ← hotel engine (unchanged paths)
src/lib/dentalEngine.ts                   ← dental intents / booking collect
```

Industry preset supplies defaults; business config overrides. Adding a new business = **one config file** + register it in `src/businesses/index.ts`.

## Add a business (blank template)

Create `src/businesses/my-clinic.ts`:

```ts
import type { BusinessConfig } from '../config/businessTypes'
import { dentalPreset } from '../industries/dental' // or hotelPreset

export const myClinicBusiness: BusinessConfig = {
  slug: 'my-clinic',
  industry: 'dental',
  name: 'My Clinic',
  greetingName: 'My Clinic',
  locale: 'en-GB',
  languages: ['en'],
  timezone: 'Europe/London',
  locations: [
    {
      name: 'Main Practice',
      address: '1 High Street',
      phone: '01xxx xxxxxx',
      hours: {
        mon: '9am–5pm',
        tue: '9am–5pm',
        wed: '9am–5pm',
        thu: '9am–5pm',
        fri: '9am–5pm',
        sat: 'closed',
        sun: 'closed',
      },
    },
  ],
  afterHoursMessage: 'We are closed right now — I can take a message for the team.',
  services: [{ name: 'Check-up' }],
  pricing: [], // only verified prices
  faqs: [{ q: 'Do you accept new patients?', a: 'Yes.', keywords: /new\s*patient/i }],
  bookingFields: dentalPreset.bookingFields,
  escalationRules: {
    humanPhrases: ['agent please'],
    modifyAsCallback: true,
    inventPrices: false,
  },
  emergency: {
    enabled: true,
    message: 'We can offer an emergency appointment — team confirms fee.',
    severeAdvice: 'If breathing or swallowing is affected, call 999 or go to A&E.',
  },
  brandColor: '#0d7377',
  logoText: 'MC',
  greetings: {
    en: "Good morning, you're through to My Clinic, how can I help?",
  },
  demoChips: {
    en: [{ label: 'New patient', text: "I'd like to register as a new patient" }],
  },
  voiceLocale: 'en-GB',
}
```

Then register in `src/businesses/index.ts`:

```ts
import { myClinicBusiness } from './my-clinic'
// …
const BUSINESSES = { erth: erthBusiness, 'mm-dental': mmDentalBusiness, 'my-clinic': myClinicBusiness }
```

## Erth hotel notes

Property facts from [erth.ae](https://erth.ae/). Edit proposal fees in `src/config/resort.ts` (`SETUP_FEE` / `MONTHLY_FEE`).

Happy-path guest script:

> I’d like a room for 2 adults and 1 child, check-in 2026-10-10, check-out 2026-10-13, late check-in after 10pm. Name is Ahmed Al Mansoori, phone +971 50 555 5555.

## MM Dental Care notes

Facts from [mmdentalcare.co.uk](https://www.mmdentalcare.co.uk/). British English (`en-GB` voice). Appointment requests are sent to the practice team — **not** live diary writes. Never invents prices outside `pricing[]`.

Demo chips include new patient, toothache, membership, reschedule, Saturday hours, nervous patient. Toggle **After-hours** for the evening emergency path.

## Environment variables

Copy `.env.example` to `.env` if you want optional live STT/TTS providers later. Mock / offline mode is the default (Web Speech API + browser TTS).

## Build

```bash
npm run build
npm run preview
```
