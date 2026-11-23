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

## Tracing, router, latency budget & eval gate

All of this runs locally and free: no LLM keys, no cloud, and nothing here sends WhatsApp/SMS/calls.

### Per-call tracing
- `server/tracing.ts`: one `trace_id` per call. Each turn is one JSONL record in `logs/traces.jsonl` (override with `TRACE_FILE`). A record has spans (`router`, `engine`/`llm`, `tool`, `fallback`, plus browser `engine`), `ttfa_ms` (end of user speech -> first bot audio, measured in the browser), `endpointing_ms`, `first_audio_ready_ms` (server), `tts_ttfb_ms`, route + router decision, tool calls, outcome, failed clarification, hand-off, fallback and errors.
- Tokens are recorded only when a real LLM reports usage. The current engine is a deterministic rule engine, so `tokens` stays `null` and nothing is estimated.
- Caller text is **not** stored. Set `TRACE_STORE_TEXT=1` to store a digit-masked preview from the server pipeline.
- Browser demo: set `VITE_TRACE=1` and run `npm run dev:all`. Each turn is POSTed to `/api/trace` without caller text. Leave it unset for normal or deployed use.

### Router (`server/router.ts`)
Each final transcript gets exactly one route:
1. `rule`: known deterministic intents (hours, fees, membership, emergency, nervous, NHS, goodbye, confirm/deny). Confidence 0.95.
2. `tool`: booking / registration / reschedule (0.9), plus slot filling while fields are being collected (0.85).
3. `retrieval`: FAQ / knowledge corpus match (0.8). With no match, confidence is 0.4.
4. `human`: explicit ask, confidence < **0.55**, or **2** consecutive failed clarifications.

The confidences are fixed heuristics per triage path, not a trained model. Every decision (`call_id, turn_id, route, reason, confidence, matched_rule, latency_ms`) is printed to stdout and appended to `logs/router_decisions.jsonl`. Fallbacks add a record with `fallback_reason`.

- In the browser the router is **observe-only** (logged, reply unchanged).
- On the server endpoint `POST /api/agent/start` -> `POST /api/agent/turn {callId, text}` it can enforce hand-off with `ROUTER_ENFORCE=1`.

### Latency budget, token cap, fallback ladder (`server/latency.ts`)
Settings: `LATENCY_BUDGET_FIRST_AUDIO_MS` (800), `LATENCY_HEADROOM_MS` (150), `MAX_TOKENS_PER_CALL` (6000), `LLM_PRIMARY_MODEL`, `LLM_FALLBACK_MODEL`, `FALLBACK_TIMEOUT_MS`, `ANSWER_CACHE_TTL_MS`, `POLICY_VERSION`.

If the primary responder misses `budget - headroom`, or errors, the ladder runs:
- (a) cached answer (normalized question + business + policy version, TTL),
- (b) smaller model, with the filler line "One moment, please." spoken at the deadline,
- (c) filler + human hand-off.

The token cap works the same way: the first breach switches to the smaller model with a short context, and the second hands off to a human. Reasons are `budget_exceeded | token_cap | llm_timeout | llm_error`.

Today the primary responder *is* the rule engine (sub-millisecond), so the ladder only fires when a slower LLM responder is plugged in. `tests/latency-fallback.test.ts` replays that with a simulated 2 s LLM.

### Reports
- `npm run report:latency [-- file.jsonl --include-eval]` -> `metrics/report.md`: p50/p95 TTFA, endpointing, engine, TTFT, TTS, by route; % over budget; fallbacks.
- `npm run report:failures [-- file.jsonl]` -> `metrics/failures.md`: categories derived only from trace fields (span errors/timeouts, tool errors, fallbacks, hand-offs by reason, low confidence, failed clarifications, generic fallback replies, empty answers, over budget).

How to record test calls for real numbers:
1. Set `VITE_TRACE=1` in `.env.local`.
2. Run `npm run dev:all`.
3. Open `/dashboard?biz=mm-dental` and do ~100 voice calls using the demo chips or your own lines.
4. Run both reports.

### Accuracy evals = release gate
- `evals/dental.jsonl`: cases built from the MM Dental config (hours, fees, membership, emergency, NHS / unpublished prices -> callback, reschedule, hand-off, low confidence, repeated clarification failure).
- `npm run eval` runs them offline through the full pipeline (router enforced) -> `metrics/eval.md`. Traces go to `logs/traces.eval.jsonl`.
- `npm run eval:gate` exits **1** if accuracy < `EVAL_THRESHOLD` (default 0.9), so it is usable as a CI step.

### Tests
- `npm test`: node:test via tsx (router, tracing, latency/fallback replay).
- `npm run typecheck:server`: type-checks the new server/scripts/tests.
