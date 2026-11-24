# Concurrency test (25 Nov 2026, 01:55 local time)

Conditions: one Node v24.22.1 process on 8× Intel(R) Xeon(R) Processor, HTTP API on localhost (express + Platform), mock LLM, in-memory store. Each call: hours, prices, then a full booking with read-back and "yes" (9 turns + start). Calls start within 20 ms of each other; 0–15 ms random gaps between a caller's turns so callers interleave. Latency = client-side HTTP round trip per request (call start + turns). Throughput = turns / wall time.

| Concurrent calls | Mix | Tenants | Turns | p50 ms | p95 ms | max ms | Throughput (turns/s) | Errors | Timeouts | Check failures | Bookings | Wrong-tenant bookings | Same-slot races (resolved) | Double-booked slots |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 10 | 5 hotel / 5 dental | 10 | 90 | 6.0 | 38.1 | 49.8 | 455 | 0 | 0 | 0 | 10 | 0 | 0 | 0 |
| 20 | 10 hotel / 10 dental | 20 | 180 | 9.1 | 11.3 | 16.9 | 925 | 0 | 0 | 0 | 20 | 0 | 0 | 0 |
| 50 | 25 hotel / 25 dental | 20 | 478 | 16.1 | 72.2 | 246.4 | 1082 | 0 | 0 | 0 | 50 | 0 | 14 | 0 |

Checks per turn: hours and prices equal the caller's own tenant config; the read-back has the caller's own name; no reply contains another tenant's name or phone; no booking before "yes". After each level: every tenant's store holds exactly the bookings its own callers confirmed.
Notes:
- This is a single run. Levels run in order in one process, so the 10-call level includes JIT warm-up, which is why its p95 is higher than at 20. Re-runs on the same box gave p50 5.5–6.0 / 8.5–9.1 / 14.4–16.1 ms and p95 36–38 / 11–41 / 41–114 ms for 10 / 20 / 50 calls.
- **Bug found and fixed:** at 50 calls (2–3 callers per clinic), callers of the same clinic were offered the same Thursday slot and confirmed it at the same moment. The store correctly refused the second write, so nothing was double-booked. But the losing caller got a dead end ("Let me find you another option." with no options). The booking agent now re-offers fresh availability in the same reply. The harness takes the first new option and confirms again; this is the "same-slot races" column.
- No real LLM, audio, network or telephony is involved. These numbers show isolation and orchestration overhead under concurrency, not phone latency.
