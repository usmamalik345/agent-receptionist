/**
 * Render ?biz=mm-dental dashboard and fail if hotel words appear in visible UI.
 * Requires: npm run build && npx vite preview (or pass BASE_URL).
 */
import { chromium } from 'playwright'

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173'
const HOTEL_LEAK =
  /\b(room|check-?in|guest|hotel|Marina|Desert\s*Palm|Opera|Booking\.com)\b/i

async function main() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  try {
    await page.goto(`${BASE}/dashboard?biz=mm-dental`, { waitUntil: 'networkidle', timeout: 60000 })
    await page.waitForSelector('text=MM Dental Care', { timeout: 15000 })
    const body = await page.locator('main').innerText()
    const m = body.match(HOTEL_LEAK)
    if (m) {
      console.error('FAIL: hotel word leaked on mm-dental dashboard:', m[0])
      console.error(body.slice(0, 500))
      process.exit(1)
    }
    // Chips should be dental
    await page.getByRole('button', { name: /Toothache|New patient|Membership/i }).first().waitFor({ timeout: 5000 })
    console.log('DENTAL_UI_LEAK_PASS')
  } finally {
    await browser.close()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
