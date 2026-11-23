/**
 * Simulated voice turn: STT -> agent -> TTS, measuring time-to-first-audio from the
 * end of caller speech. Adapters are injected (tests/harness use fakes; nothing here
 * talks to a real STT/TTS vendor). If TTS cannot produce its first byte inside the
 * budget, a pre-rendered filler clip is played so the caller is never left in silence.
 */
import type { AgentRuntime, TurnResult } from './agentTurn.ts'

export interface SttAdapter {
  transcribe(audio: { text: string }): Promise<string>
}
export interface TtsAdapter {
  /** Resolves when the first audio byte for `text` is ready. */
  firstByte(text: string): Promise<void>
}

export interface VoiceTurnResult {
  turn: TurnResult
  sttMs: number
  /** end of caller speech -> first audio byte the caller hears */
  ttfaMs: number
  firstAudioSource: 'tts' | 'filler_clip'
  firstAudioText: string
}

export async function runVoiceTurn(
  agent: AgentRuntime,
  callId: string,
  audio: { text: string },
  deps: { stt: SttAdapter; tts: TtsAdapter; budgetMs?: number; fillerClipText?: string },
): Promise<VoiceTurnResult> {
  const budget = deps.budgetMs ?? agent.config.budgetMs
  const t0 = performance.now()
  const since = () => Math.round(performance.now() - t0)
  const text = await deps.stt.transcribe(audio)
  const sttMs = since()

  let resolveFirst!: (v: { at: number; source: 'tts' | 'filler_clip'; text: string }) => void
  const first = new Promise<{ at: number; source: 'tts' | 'filler_clip'; text: string }>((r) => (resolveFirst = r))
  let done = false
  const finish = (source: 'tts' | 'filler_clip', t: string) => {
    if (done) return
    done = true
    resolveFirst({ at: since(), source, text: t })
  }
  // Pre-rendered filler clip is the safety net: armed at the budget from end of speech.
  const clipTimer = setTimeout(() => finish('filler_clip', deps.fillerClipText ?? 'One moment, please.'), Math.max(0, budget - since()))
  clipTimer.unref?.()

  const turn = await agent.turn(callId, text, {
    sttMs,
    onFirstAudio: (t) => {
      void deps.tts.firstByte(t).then(() => finish('tts', t))
    },
  })
  const fa = await first
  clearTimeout(clipTimer)
  return { turn, sttMs, ttfaMs: fa.at, firstAudioSource: fa.source, firstAudioText: fa.text }
}
