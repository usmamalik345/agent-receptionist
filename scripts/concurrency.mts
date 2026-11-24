/** npm run test:concurrency [-- --levels=10,20,50] : simultaneous calls through the HTTP API, mock LLM. Writes metrics/concurrency.md. */
import { mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runLevel } from './lib/concurrency.mts'

const levels = (process.argv.find((a) => a.startsWith('--levels='))?.split('=')[1] ?? '10,20,50').split(',').map(Number)
const rows = []
let bad = 0
for (const n of levels) {
  const r = await runLevel(n)
  rows.push(r)
  bad += r.failures.length + r.errors + r.timeouts
  console.log(`${n} calls: ${r.turns} turns, ${r.failures.length} failures, p50 ${r.p50.toFixed(1)} ms, p95 ${r.p95.toFixed(1)} ms, ${r.throughputTurnsPerSec.toFixed(0)} turns/s`)
  for (const f of r.failures.slice(0, 10)) console.log('  ' + f)
}
const when = new Date().toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
const md = [`# Concurrency test (${when} local time)`, '',
  `Conditions: one Node ${process.version} process on ${os.cpus().length}× ${os.cpus()[0]?.model.trim()}, HTTP API on localhost (express + Platform), mock LLM, in-memory store. Each call: hours, prices, then a full booking with read-back and "yes" (9 turns + start). Calls start within 20 ms of each other; 0–15 ms random gaps between a caller's turns so callers interleave. Latency = client-side HTTP round trip per request (call start + turns). Throughput = turns / wall time.`, '',
  '| Concurrent calls | Mix | Tenants | Turns | p50 ms | p95 ms | max ms | Throughput (turns/s) | Errors | Timeouts | Check failures | Bookings | Wrong-tenant bookings | Same-slot races (resolved) | Double-booked slots |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.level} | ${r.hotel} hotel / ${r.dental} dental | ${r.tenants} | ${r.turns} | ${r.p50.toFixed(1)} | ${r.p95.toFixed(1)} | ${r.max.toFixed(1)} | ${r.throughputTurnsPerSec.toFixed(0)} | ${r.errors} | ${r.timeouts} | ${r.failures.length} | ${r.bookings} | ${r.wrongTenantBookings} | ${r.slotConflicts} | ${r.doubleBooked} |`), '',
  'Checks per turn: hours and prices equal the caller\'s own tenant config; the read-back has the caller\'s own name; no reply contains another tenant\'s name or phone; no booking before "yes". After each level: every tenant\'s store holds exactly the bookings its own callers confirmed.', '']
mkdirSync('metrics', { recursive: true })
writeFileSync(path.join('metrics', 'concurrency.md'), md.join('\n'))
console.log(bad ? 'CONCURRENCY_FAIL' : 'CONCURRENCY_PASS')
process.exit(bad ? 1 : 0)
