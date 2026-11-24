/** Voice realism (free): natural voice ranking, sentence chunking, humanized wording. Text-only checks; no audio is measured. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { naturalRate, pickBestVoice, speechChunks } from '../src/lib/voicePick.ts'
import { acknowledgement, humanize, sentences } from '../server/platform/speech.ts'

const VOICES = [
  { name: 'Microsoft David Desktop - English (United States)', lang: 'en-US' },
  { name: 'Microsoft Hazel Desktop - English (Great Britain)', lang: 'en-GB' },
  { name: 'Google UK English Female', lang: 'en-GB' },
  { name: 'Microsoft Sonia Online (Natural) - English (United Kingdom)', lang: 'en-GB' },
  { name: 'Microsoft Aria Online (Natural) - English (United States)', lang: 'en-US' },
  { name: 'Google français', lang: 'fr-FR' },
]

test('picks the Edge Natural voice for the locale, then Google, never a robotic desktop voice', () => {
  assert.match(pickBestVoice(VOICES, 'en-GB')!.name, /Sonia Online \(Natural\)/)
  assert.match(pickBestVoice(VOICES, 'en-US')!.name, /Aria Online \(Natural\)/)
  const noEdge = VOICES.filter((v) => !/Natural/.test(v.name))
  assert.equal(pickBestVoice(noEdge, 'en-GB')!.name, 'Google UK English Female')
  assert.equal(pickBestVoice([VOICES[5]], 'en-GB'), null, 'never a French voice for English text')
})

test('tenant persona preference wins when installed', () => {
  assert.equal(pickBestVoice(VOICES, 'en-GB', ['Google UK English Female'])!.name, 'Google UK English Female')
  assert.match(pickBestVoice(VOICES, 'en-GB', ['Not Installed Voice'])!.name, /Sonia/)
})

test('rate: neural voices at 1.0, old voices slightly slower', () => {
  assert.equal(naturalRate(VOICES[3]), 1)
  assert.equal(naturalRate(VOICES[0]), 0.92)
})

test('chunks by sentence for streaming TTS; long sentences split at commas', () => {
  assert.deepEqual(speechChunks('Sure. We open at 9am. See you then!'), ['Sure.', 'We open at 9am.', 'See you then!'])
  const long = 'For three nights from Friday the 27th of November, I have a Standard Double at £95 a night, or a Twin at £105 a night, both with free wifi and breakfast.'
  assert.ok(speechChunks(long, 80).every((c) => c.length <= 80))
  assert.deepEqual(sentences('Hi there. How can I help?'), ['Hi there.', 'How can I help?'])
})

test('humanize: contractions, no markdown/lists, facts untouched', () => {
  assert.equal(humanize('We are open until 7pm. I will check. It is £55.'), "We're open until 7pm. I'll check. It's £55.")
  assert.equal(humanize('- **Check-up**: £55\n- Filling: £120'), 'Check-up: £55. Filling: £120')
  assert.equal(humanize('Do not worry, you are booked.'), "Don't worry, you're booked.")
  assert.notEqual(acknowledgement('warm', 0), acknowledgement('warm', 1))
})
