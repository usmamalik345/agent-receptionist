# Design directions (prototypes, sample data)

Static HTML mockups, one CSS file per direction. Open any `.html` file in a browser. Each is laid out for a 1440×900 screen. All businesses, callers and numbers are fictional SAMPLE data. The prices come from `config/tenants/*.json`.

| Direction | Files | Idea |
|---|---|---|
| A · Front-desk Ledger | `a-ledger-*.html`, `a-ledger.css` | Warm editorial look: cream paper, Fraunces serif headings, Source Sans 3 body, IBM Plex Mono for times, one terracotta accent. Calls read like a hotel logbook; agent steps appear as margin notes; the booking is a "draft" card. |
| B · Switchboard | `b-switchboard-*.html`, `b-switchboard.css` | Dense ops console: Inter and JetBrains Mono, neutral greys, one teal accent, keyboard hints everywhere. The hero is the live call shown as per-agent swim lanes, with a handoff and slot inspector. Test call is a scenario runner with turn latency strips. |
| C · Concierge | `c-concierge-*.html`, `c-concierge.css` | Friendly hospitality look: Manrope, soft neutrals, deep pine accent, rounded but restrained. The dashboard is a "Today" view with the live call and its waveform and plain-language steps. Test call is voice-first, with a large mic and a booking card that fills in as you talk. |

Spacing is on a 4/8 px scale in all three. None of them use gradients, glass effects, emoji or sparkle icons.
