/**
 * Record MM Dental Care client video (Playwright).
 * Output: recordings/mm-dental-client-demo.webm
 *
 * Usage: npx tsx scripts/record-client-video.mts
 * Requires: npm run dev on :5173 (or BASE_URL)
 */
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const BASE = process.env.BASE_URL || 'http://127.0.0.1:5173'
const OUT_DIR = path.resolve('recordings')
const OUT_FILE = path.join(OUT_DIR, 'mm-dental-client-demo.webm')

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })

  const browser = await chromium.launch({
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required'],
  })

  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    recordVideo: {
      dir: OUT_DIR,
      size: { width: 1400, height: 900 },
    },
  })

  const page = await context.newPage()

  // Instant TTS so the visual demo doesn't wait on voices
  await page.addInitScript(() => {
    const proto = window.SpeechSynthesisUtterance?.prototype
    const speak = (utter: SpeechSynthesisUtterance) => {
      const fire = () => {
        try {
          utter.dispatchEvent(new Event('start'))
          utter.onstart?.(new SpeechSynthesisEvent('start', { utterance: utter } as SpeechSynthesisEventInit))
        } catch {
          /* ignore */
        }
        setTimeout(() => {
          try {
            utter.dispatchEvent(new Event('end'))
            utter.onend?.(new SpeechSynthesisEvent('end', { utterance: utter } as SpeechSynthesisEventInit))
          } catch {
            /* ignore */
          }
        }, 120)
      }
      fire()
    }
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel = () => {}
      window.speechSynthesis.pause = () => {}
      window.speechSynthesis.resume = () => {}
      window.speechSynthesis.speak = speak as typeof window.speechSynthesis.speak
      Object.defineProperty(window.speechSynthesis, 'speaking', { get: () => false })
      Object.defineProperty(window.speechSynthesis, 'pending', { get: () => false })
    }
    void proto
  })

  console.log('Opening client video page…')
  await page.goto(`${BASE}/record-demo?biz=mm-dental`, { waitUntil: 'networkidle', timeout: 60000 })
  await page.getByRole('button', { name: /Play client video/i }).waitFor({ timeout: 15000 })

  // Hold title card briefly for the recording
  await page.waitForTimeout(1500)

  console.log('Playing demo…')
  await page.getByRole('button', { name: /Play client video/i }).click()

  // Wait until film mode shows Demo complete / Ready for MM Dental Care
  await page.waitForSelector('text=Ready for MM Dental Care', { timeout: 180000 })
  console.log('Demo complete — holding final frame…')
  await page.waitForTimeout(3500)

  const video = page.video()
  await context.close()
  await browser.close()

  if (!video) {
    console.error('No video object')
    process.exit(1)
  }

  const tmp = await video.path()
  fs.renameSync(tmp, OUT_FILE)
  const stat = fs.statSync(OUT_FILE)
  console.log('SAVED', OUT_FILE)
  console.log('SIZE_MB', (stat.size / (1024 * 1024)).toFixed(2))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
