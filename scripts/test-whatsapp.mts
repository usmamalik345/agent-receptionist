/**
 * CLI: send one real WhatsApp missed-call alert using .env
 * Usage: npm run test:wa
 * Optional: npm run test:wa -- +9715XXXXXXXX
 */
import 'dotenv/config'

const toArg = process.argv[2]
const base = `http://127.0.0.1:${process.env.PORT || 8787}`

async function main() {
  const healthRes = await fetch(`${base}/api/health`)
  if (!healthRes.ok) {
    console.error('Bridge not running. Start with: npm run dev:server  (or npm run dev:all)')
    process.exit(1)
  }
  const health = await healthRes.json()
  console.log('Health:', health)

  const res = await fetch(`${base}/api/missed-call`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      guestName: 'Ahmed Al Mansoori',
      phone: '+971 50 555 5555',
      checkIn: '2026-10-10',
      checkOut: '2026-10-13',
      adults: 2,
      children: 1,
      specialRequests: 'Late check-in after 10pm',
      ...(toArg ? { to: toArg } : {}),
    }),
  })
  const data = await res.json()
  console.log(res.status, data)
  if (!data.ok) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
