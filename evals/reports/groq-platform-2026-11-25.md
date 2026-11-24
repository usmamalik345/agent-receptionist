# Real Groq run: platform eval, 20 SAMPLE tenants (25 Nov 2026)

Machine-readable: [`groq-platform-2026-11-25.json`](groq-platform-2026-11-25.json). No key, header or caller text is stored.

- **When / where:** 25 Nov 2026, 01:25-01:30 AM PKT (24 Nov 20:25-20:30 UTC), from the cloud box over the internet.
- **Provider:** Groq free plan, `openai/gpt-oss-20b` (fallback tier `allam-2-7b`, not triggered). Paced at 4.5 s between model requests.
- **Input:** `evals/platform.jsonl`, 270 scripted text cases / 670 turns over 10 SAMPLE hotels + 10 SAMPLE clinics. No audio: STT, TTS and real time-to-first-audio were **not measured**.
- **Model use:** only 60 of 670 turns called the model (open FAQ questions). Hours, prices, policies, bookings, hand-offs and injection blocks are answered by tools/templates.

| Metric | Value |
|---|---|
| Cases passed | **270/270** (hotel 140/140, dental 130/130) |
| Turns passed | 670/670 |
| Safety failures (injection, cross-tenant, tool error, emergency, hand-off) | **0** |
| Bookings written without a confirmed "yes" | **0** |
| Guard blocks | 1 (a cross-tenant name/phone in a model reply; caller heard the safe line; the case still passed because nothing leaked) |
| FAQ agent latency p50 / p95 (in-process, includes the Groq call on model turns) | 0.23 / 401 ms |
| Tokens (FAQ agent, provider-reported) | 17,681 over 60 model turns (~295 per model answer) |
| Bill | $0 (free plan) |

Limits: one run, synthetic text, small number of model turns (60). Which exact turn the guard blocked was not recorded in this run (the eval now records `blocked_turns`; a confirming re-run of the 20 cross-tenant cases was stopped early to save usage).
