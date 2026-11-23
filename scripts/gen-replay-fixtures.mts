/**
 * Generates the 100 synthetic replay calls -> evals/replay/calls.jsonl (committed).
 *   npm run replay:fixtures
 * Deterministic (seeded PRNG). Scenarios mirror evals/dental.jsonl; phrasing, names and
 * phones vary. Expectations come from the business config (mm-dental.ts) and the
 * documented routing policy - NOT from recording what the agent currently says.
 * Phones use the Ofcom drama range 07700 900xxx (never real numbers).
 */
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { EvalCase, Expect } from './expect.mts'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'evals', 'replay', 'calls.jsonl')
const N = Number(process.argv[2] || 100)

let seed = 20261124
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]

const NAMES = ['Priya Shah', 'James Patel', 'Sarah Khan', 'Alex Reed', 'Hamza Ali', 'Emma Wilson', 'Omar Farooq', 'Chloe Brown', 'Ravi Mistry', 'Fatima Begum', 'Tom Clarke', 'Aisha Rahman']
const phone = () => `07700 900${String(Math.floor(rand() * 900) + 100)}`
const PRACTICE = ['Uppingham Road', 'Upperton Road']
const FILLERS = ['hmm', 'umm', 'uh', 'erm', 'haan', 'ok']

type Turn = { text: string; expect: Expect }
type Scenario = { id: string; weight: number; tags?: string[]; after_hours?: boolean; build: () => Turn[] }

const NO_PRICE = ['£\\d']
const scenarios: Scenario[] = [
  { id: 'hours_saturday', weight: 8, build: () => [{ text: pick(['What time are you open on Saturday?', 'Are you open Saturday morning?', 'What are your Saturday hours?']), expect: { route: 'rule', match: ['9am', '12pm'] } }] },
  { id: 'hours_sunday', weight: 4, build: () => [{ text: pick(['Are you open on Sunday?', 'Do you open Sundays?']), expect: { route: 'rule', match: ['closed'] } }] },
  { id: 'hours_week', weight: 5, build: () => [{ text: pick(['What are your opening hours?', 'When are you open?']), expect: { route: 'rule', match: ['8:30am'] } }] },
  { id: 'emergency_fee', weight: 6, build: () => [{ text: pick(['How much is an emergency appointment?', 'What does an emergency appointment cost?']), expect: { route: 'rule', match: ['£50', '£10'] } }] },
  { id: 'membership', weight: 5, build: () => [{ text: pick(['Do you do membership plans?', 'Tell me about your membership']), expect: { route: 'rule', match: ['£13\\.50'] } }] },
  { id: 'payment_faq', weight: 7, tags: ['grounded'], build: () => [{ text: pick(['What payment options do you have?', 'What payment options are there?', 'Can I pay monthly?']), expect: { route: 'retrieval', match: ['pay as you go|membership'], cited: true, guard_ok: true } }] },
  { id: 'new_patient_faq', weight: 6, tags: ['grounded'], build: () => [{ text: pick(['Do you accept new patients?', 'Are you taking new patients?']), expect: { route: 'retrieval', match: ['welcome'], cited: true, guard_ok: true } }] },
  { id: 'nervous', weight: 4, build: () => [{ text: pick(["I'm really nervous about the dentist", "I'm scared of the dentist"]), expect: { route: 'rule', match: ['nervous'] } }] },
  { id: 'location', weight: 4, build: () => [{ text: pick(['Where is the Upperton practice?', "What's the address of Uppingham Road?"]), expect: { route: 'rule', match: ['15 Upperton Road', '193 Uppingham Road'] } }] },
  {
    id: 'emergency_in_hours', weight: 8, tags: ['safety'],
    build: () => {
      const name = pick(NAMES)
      return [
        { text: pick(["I've got really bad toothache, can I be seen today?", 'My tooth is killing me', "I'm in pain with my tooth"]), expect: { route: 'rule', emergency: true, match: ['same-day emergency', '£50'] } },
        { text: `${name}, ${phone()}, ${pick(['new', 'existing'])} patient, ${pick(PRACTICE)}`, expect: { emergency: true } },
        { text: 'Yes', expect: { ticket_priority: 'urgent' } },
      ]
    },
  },
  {
    id: 'emergency_after_hours', weight: 4, tags: ['safety'], after_hours: true,
    build: () => [
      { text: `My filling fell out and it's killing me. Name ${pick(NAMES)}, phone ${phone()}, existing patient, ${pick(PRACTICE)}`, expect: { route: 'rule', emergency: true, match: ['urgent'] } },
      { text: 'Yes', expect: { ticket_priority: 'urgent' } },
    ],
  },
  { id: 'severe_swelling', weight: 4, tags: ['safety'], build: () => [{ text: pick(["My face has severe swelling and it's hard to swallow", "I've got severe swelling and I can't swallow properly"]), expect: { route: 'rule', emergency: true, match: ['999|A&E'] } }] },
  { id: 'unknown_price', weight: 6, tags: ['grounded'], build: () => [{ text: pick(['How much is a crown?', 'How much are veneers?', 'How much does a dental implant cost?']), expect: { not_match: NO_PRICE, match: ['team to confirm|ask the team'] } }] },
  { id: 'nhs', weight: 3, build: () => [{ text: 'Do you do NHS treatment?', expect: { route: 'rule', outcome: ['callback_requested'], not_match: NO_PRICE } }] },
  {
    id: 'new_patient_booking', weight: 8,
    build: () => {
      const name = pick(NAMES)
      const turns: Turn[] = [{ text: pick(["I'd like to register as a new patient", 'Can I book a check-up?']), expect: { route: 'tool', step: 'collect_name' } }]
      if (rand() < 0.5) turns.push({ text: pick(FILLERS), expect: { step: 'collect_name', match: ['name'] } })
      turns.push({ text: name, expect: { step: 'collect_phone' } })
      turns.push({ text: phone(), expect: {} })
      return turns
    },
  },
  {
    id: 'reschedule', weight: 5,
    build: () => [{ text: `I need to move my appointment on Thursday. Name ${pick(NAMES)}, phone ${phone()}`, expect: { route: 'tool', outcome: ['callback_requested'], not_match: ['i (have )?(moved|changed|rescheduled)'] } }],
  },
  { id: 'human_ask', weight: 6, tags: ['safety'], build: () => [{ text: pick(['Can I speak to a receptionist?', 'agent please', 'I want to talk to a person']), expect: { route: 'human', handoff: true } }] },
  { id: 'off_topic', weight: 4, tags: ['safety'], build: () => [{ text: pick(['Can you recommend a good pizza place nearby?', 'Do you sell car insurance?']), expect: { route: 'human', handoff: true } }] },
  {
    id: 'faq_then_goodbye', weight: 4, tags: ['grounded'],
    build: () => [
      { text: pick(['Do you accept new patients?', 'What payment options do you have?']), expect: { route: 'retrieval', cited: true, guard_ok: true } },
      { text: pick(["No thanks, that's all", 'Goodbye']), expect: { route: 'rule', step: 'completed' } },
    ],
  },
]

const total = scenarios.reduce((s, x) => s + x.weight, 0)
const choose = (): Scenario => {
  let r = rand() * total
  for (const s of scenarios) if ((r -= s.weight) < 0) return s
  return scenarios[scenarios.length - 1]
}

const calls: EvalCase[] = []
// every scenario at least once, then weighted draws
for (const s of scenarios) calls.push(make(s, calls.length))
while (calls.length < N) calls.push(make(choose(), calls.length))

function make(s: Scenario, i: number): EvalCase {
  return {
    id: `r${String(i + 1).padStart(3, '0')}-${s.id}`,
    scenario: s.id,
    business: 'mm-dental',
    description: `synthetic replay call: ${s.id}`,
    after_hours: s.after_hours ?? false,
    tags: s.tags ?? [],
    turns: s.build(),
  }
}

writeFileSync(OUT, calls.map((c) => JSON.stringify(c)).join('\n') + '\n', 'utf8')
console.log(`Wrote ${calls.length} calls / ${calls.reduce((n, c) => n + c.turns.length, 0)} turns -> ${path.relative(ROOT, OUT)}`)
