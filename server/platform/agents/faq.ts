/**
 * FAQ agent: hours, prices, policies, emergencies and general questions.
 * Structured facts come from config tools (get_hours, get_prices, get_policy) and are
 * spoken from templates - no model. Open questions go search_knowledge (BM25 over the
 * tenant's own config) -> response agent (LLM, cited) behind the latency ladder + cache.
 */
import type { HoursAnswer } from '../../agents/hoursTool.ts'
import { runResponseAgent } from '../../agents/response.ts'
import type { RetrievalResult } from '../../agents/retrieval.ts'
import type { ResponseCache } from '../../cache.ts'
import { respondWithinBudget, type LatencyConfig, type TokenBudget } from '../../latency.ts'
import type { LlmClient } from '../../llm.ts'
import type { AgentReply, ToolCallRecord } from '../protocol.ts'
import { spokenList } from '../speech.ts'
import type { Tenant } from '../tenant.ts'
import { callTool, type ToolContext } from '../tools.ts'
import type { TriageResult } from './triage.ts'

export interface FaqDeps {
  tenant: Tenant
  ctx: ToolContext
  llm: LlmClient
  cache: ResponseCache
  config: LatencyConfig
  tokens: TokenBudget
  callId: string
  tools: ToolCallRecord[]
}

const brand = (t: Tenant) => t.name.replace(/\s*\(SAMPLE\)\s*/i, '')
const reply = (text: string, decision: string, grounding: string[], extra: Partial<AgentReply> = {}): AgentReply => ({
  type: 'reply', agent: 'faq', text, source: 'template', grounding, citations: [], model: null, tokens: null, decision, ...extra,
})
export const CLARIFY_TEXT = (t: Tenant) =>
  `Sorry, I didn't quite catch that. I can help with ${t.vertical === 'hotel' ? 'room bookings' : 'appointments'}, opening hours, prices, or questions about ${brand(t)}.`

export async function runFaqAgent(d: FaqDeps, text: string, tr: TriageResult): Promise<AgentReply & { llmMeta?: { ttftMs: number | null; cacheHit: boolean; step: string; fallback: string | null } }> {
  const t = d.tenant
  const invoke = async <T>(name: string, args: Record<string, unknown>) => {
    const r = await callTool<T>('faq', name, args, d.ctx)
    d.tools.push(r.record)
    return r
  }
  switch (tr.intent) {
    case 'greeting':
      return reply(`Hi, you're through to ${brand(t)}, this is ${t.voice.agentName}. How can I help?`, 'greeting', [])
    case 'goodbye':
      return reply(`Thanks for calling ${brand(t)}. Bye for now.`, 'goodbye', [])
    case 'emergency': {
      const e = t.dental!.emergency
      if (tr.severe) return reply(`${e.severeAdvice} ${e.message}`, 'emergency_severe', [e.severeAdvice, e.message], { escalate: { reason: 'severe_symptoms' } })
      return reply(`I'm sorry you're in pain. ${e.message} Would you like me to book an emergency appointment?`, 'emergency', [e.message])
    }
    case 'hours': {
      const r = await invoke<HoursAnswer | null>('get_hours', { question: text })
      if (r.ok && r.result) return reply(r.result.text, 'get_hours', t.locations.map((l) => JSON.stringify(l.hours)), { source: 'tool', citations: r.result.citations })
      break
    }
    case 'prices': {
      const r = await invoke<Array<{ item: string; price: string | null }>>('get_prices', {})
      if (!r.ok) break
      const items = r.result
      const hit = items.filter((i) => text.toLowerCase().includes(i.item.toLowerCase().split(/\s+/)[0]))
      const grounding = items.map((i) => `${i.item}: ${i.price}`)
      if (hit.length === 1) {
        const i = hit[0]
        return reply(i.price ? `${/^[aeiou]/i.test(i.item) ? 'An' : 'A'} ${i.item.toLowerCase()} is ${i.price}${t.hotel ? '' : ''}.` : t.hotel ? `The rate for the ${i.item} depends on your dates, so reservations will confirm it.` : `The price for ${i.item.toLowerCase()} is given after an assessment, so the team will confirm it.`, 'get_prices:item', grounding, { source: 'tool' })
      }
      const priced = items.filter((i) => i.price).slice(0, 3)
      if (!priced.length) {
        const names = items.slice(0, 3).map((i) => (t.hotel ? `the ${i.item}` : i.item.toLowerCase()))
        return reply(t.hotel ? `Rates depend on your dates, so reservations will confirm them. Rooms include ${spokenList(names)}. Would you like me to check dates for you?` : `Prices are given after an assessment, so the team will confirm them. We offer ${spokenList(names)}.`, 'get_prices:unpublished', grounding, { source: 'tool' })
      }
      return reply(`${spokenList(priced.map((i) => `${i.item.toLowerCase()} is ${i.price}`))}. Is there something specific you'd like a price for?`.replace(/^./, (c) => c.toUpperCase()), 'get_prices:list', grounding, { source: 'tool' })
    }
    case 'policy': {
      const r = await invoke<{ checkIn: string; checkOut: string; cancellation: string }>('get_policy', {})
      if (!r.ok) break
      const p = r.result
      const g = [`check-in ${p.checkIn}`, `check-out ${p.checkOut}`, p.cancellation]
      if (/cancel|refund/i.test(text)) return reply(p.cancellation, 'get_policy:cancellation', g, { source: 'tool' })
      return reply(`Check-in is from ${p.checkIn}, and check-out is by ${p.checkOut}.`, 'get_policy:times', g, { source: 'tool' })
    }
  }
  // Open question -> retrieval + response agent (LLM) behind the latency ladder
  const s = await invoke<RetrievalResult>('search_knowledge', { query: text })
  if (!s.ok) return reply(CLARIFY_TEXT(t), 'tool_error', [], { escalate: { reason: `tool_failure:search_knowledge:${s.error}` } })
  if (!s.result.grounded) return reply(CLARIFY_TEXT(t), 'no_grounded_passage', [])
  const passages = s.result.passages
  let citations: string[] = []
  let estimated = false
  const responder = (tier: 'primary' | 'small') => ({
    name: `response:${tier}`,
    respond: async ({ text: q, shortContext, signal }: { text: string; shortContext?: boolean; signal?: AbortSignal }) => {
      const out = await runResponseAgent(d.llm, { business: brand(t), question: q, passages, tier, shortContext, signal, hours: t.locations })
      citations = out.citations
      estimated = out.usage.estimated
      return { text: out.text, model: out.model, ttftMs: out.ttftMs, ...(out.tool ? {} : { tokens: { prompt: out.usage.prompt, completion: out.usage.completion } }) }
    },
  })
  const ladder = await respondWithinBudget(d.callId, t.id, text, {
    config: { ...d.config, policyVersion: t.policyVersion, primaryModel: d.llm.primaryModel, fallbackModel: d.llm.smallModel },
    primary: responder('primary'),
    fallback: responder('small'),
    cache: d.cache,
    tokens: d.tokens,
    cacheable: true,
    writeCache: false,
  })
  void estimated
  const cited = passages.filter((p) => citations.includes(p.id))
  return {
    ...reply(ladder.text, `llm:${ladder.step}`, (cited.length ? cited : passages).map((p) => p.text), {
      source: ladder.step === 'human' ? 'template' : 'llm',
      citations: ladder.step === 'cache' ? [] : citations,
      model: ladder.model,
      tokens: ladder.tokens,
      escalate: ladder.handoff ? { reason: `fallback:${ladder.fallback?.reason}` } : undefined,
    }),
    llmMeta: { ttftMs: ladder.ttftMs, cacheHit: ladder.cacheHit, step: ladder.step, fallback: ladder.fallback?.reason ?? null },
  }
}
