/**
 * Response agent: writes the spoken reply ONLY from retrieved passages.
 * The model must cite passage ids in [brackets]; citations are stripped before TTS
 * and kept in the trace. Runs through the pluggable LlmClient (mock by default).
 */
import type { LlmClient, LlmUsage } from '../llm.ts'
import type { ScoredPassage } from './retrieval.ts'
import { answerHoursQuestion, type HoursLocation } from './hoursTool.ts'

export const RESPONSE_SYSTEM_PROMPT = [
  'You are the phone receptionist for {business}.',
  'Answer the caller in at most 2 short spoken sentences, using ONLY the facts in CONTEXT.',
  'Never state a price, time, date, name or phone number that is not written in CONTEXT.',
  'If CONTEXT does not answer the question, say you will ask the team to confirm.',
  'If CONTEXT gives different answers for different locations, say each one briefly; keep qualifiers such as "phone lines only".',
  'End each fact with the id of the passage it came from in square brackets, e.g. [faq:0].',
  'No markdown, no lists.',
].join('\n')

export interface ResponseAgentOutput {
  text: string
  rawText: string
  citations: string[]
  usage: LlmUsage
  model: string
  ttftMs: number
  /** Set when a config tool answered instead of the model (e.g. get_hours) */
  tool?: 'get_hours'
}

/** Fallback tier settings (env): fewer passages and fewer tokens so the small model answers fast. */
export const smallTierConfig = (env: Record<string, string | undefined> = process.env) => ({
  contextPassages: Math.max(1, Number(env.LLM_SMALL_CONTEXT_PASSAGES || 1) || 1),
  maxTokens: Math.max(16, Number(env.LLM_SMALL_MAX_TOKENS || 80) || 80),
})

export function buildResponseMessages(business: string, question: string, passages: ScoredPassage[], shortContext = false, shortPassages = 1) {
  const ctx = (shortContext ? passages.slice(0, shortPassages) : passages).map((p) => `[${p.id}] ${p.text}`).join('\n')
  return [
    { role: 'system' as const, content: RESPONSE_SYSTEM_PROMPT.replace('{business}', business) },
    { role: 'user' as const, content: `CONTEXT:\n${ctx || '(none)'}\n\nCALLER: ${question}` },
  ]
}

/**
 * Real models (seen with gpt-oss on Groq) put typographic characters into plain
 * facts: narrow no-break spaces inside phone numbers (0116\u202f247\u202f0431),
 * non-breaking hyphens (Same\u2011day), curly apostrophes. Normalise them so the
 * spoken text, guard regexes, cache and transcripts all see plain text.
 */
export function normalizeSpoken(text: string): string {
  return text
    .replace(/[\u00a0\u2007\u2009\u202f]/g, ' ')
    .replace(/[\u2010\u2011]/g, '-')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
}

const CITE = /\s*\[([a-z_-]+(?::[a-z0-9-]+)?)\]/gi

export function extractCitations(text: string, allowed: Set<string>): { spoken: string; citations: string[] } {
  const citations: string[] = []
  const spoken = normalizeSpoken(text)
    .replace(CITE, (_m, id: string) => {
      if (allowed.has(id) && !citations.includes(id)) citations.push(id)
      return ''
    })
    .replace(/\s+([.,!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim()
  return { spoken, citations }
}

export async function runResponseAgent(
  llm: LlmClient,
  input: {
    business: string
    question: string
    passages: ScoredPassage[]
    tier?: 'primary' | 'small'
    shortContext?: boolean
    maxTokens?: number
    signal?: AbortSignal
    /** When given, opening-hours questions are answered by the get_hours tool from config (no model call). */
    hours?: HoursLocation[]
  },
): Promise<ResponseAgentOutput> {
  if (input.hours) {
    const t0 = performance.now()
    const h = answerHoursQuestion(input.hours, input.question)
    if (h) {
      return {
        text: h.text, rawText: h.text, citations: h.citations, usage: { prompt: 0, completion: 0, estimated: false },
        model: 'tool:get_hours', ttftMs: Math.round((performance.now() - t0) * 100) / 100, tool: 'get_hours',
      }
    }
  }
  // The small (fallback) tier always runs with the short context and a smaller token budget.
  const small = (input.tier ?? 'primary') === 'small'
  const sc = smallTierConfig()
  const res = await llm.complete({
    messages: buildResponseMessages(input.business, input.question, input.passages, input.shortContext || small, sc.contextPassages),
    tier: input.tier ?? 'primary',
    maxTokens: input.maxTokens ?? (small ? sc.maxTokens : 120),
    signal: input.signal,
  })
  const { spoken, citations } = extractCitations(res.text, new Set(input.passages.map((p) => p.id)))
  return { text: spoken, rawText: res.text, citations, usage: res.usage, model: res.model, ttftMs: res.ttftMs }
}
