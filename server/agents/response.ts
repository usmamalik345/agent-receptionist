/**
 * Response agent: writes the spoken reply ONLY from retrieved passages.
 * The model must cite passage ids in [brackets]; citations are stripped before TTS
 * and kept in the trace. Runs through the pluggable LlmClient (mock by default).
 */
import type { LlmClient, LlmUsage } from '../llm.ts'
import type { ScoredPassage } from './retrieval.ts'

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
}

export function buildResponseMessages(business: string, question: string, passages: ScoredPassage[], shortContext = false) {
  const ctx = (shortContext ? passages.slice(0, 1) : passages).map((p) => `[${p.id}] ${p.text}`).join('\n')
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
  input: { business: string; question: string; passages: ScoredPassage[]; tier?: 'primary' | 'small'; shortContext?: boolean; maxTokens?: number; signal?: AbortSignal },
): Promise<ResponseAgentOutput> {
  const res = await llm.complete({
    messages: buildResponseMessages(input.business, input.question, input.passages, input.shortContext),
    tier: input.tier ?? 'primary',
    maxTokens: input.maxTokens ?? 120,
    signal: input.signal,
  })
  const { spoken, citations } = extractCitations(res.text, new Set(input.passages.map((p) => p.id)))
  return { text: spoken, rawText: res.text, citations, usage: res.usage, model: res.model, ttftMs: res.ttftMs }
}
