/** Bug fix: the fallback tier used the same model with full context. Now: smaller model, 1 passage, small token budget. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runResponseAgent } from '../server/agents/response.ts'
import { buildPassages } from '../server/agents/retrieval.ts'
import { loadLlmClient, type LlmClient, type LlmRequest } from '../server/llm.ts'
import { mmDentalBusiness } from '../src/businesses/index.ts'

test('groq default fallback model differs from the primary', () => {
  const c = loadLlmClient({ LLM_PROVIDER: 'groq', LLM_API_KEY: 'test-not-a-key' })
  assert.equal(c.primaryModel, 'openai/gpt-oss-20b')
  assert.equal(c.smallModel, 'allam-2-7b')
  assert.notEqual(c.smallModel, c.primaryModel)
  assert.equal(loadLlmClient({ LLM_PROVIDER: 'groq', LLM_API_KEY: 'x', LLM_SMALL_MODEL: 'tiny' }).smallModel, 'tiny')
})

test('small tier: short context (1 passage) and smaller max_tokens', async () => {
  const seen: LlmRequest[] = []
  const llm: LlmClient = {
    provider: 'mock', primaryModel: 'p', smallModel: 's', note: '',
    async complete(req) {
      seen.push(req)
      return { text: 'ok [faq:1]', model: req.tier === 'small' ? 's' : 'p', provider: 'mock', usage: { prompt: 1, completion: 1, estimated: false }, ttftMs: 1 }
    },
  }
  const q = 'What payment options do you have?'
  const passages = buildPassages(mmDentalBusiness).slice(0, 3).map((p) => ({ ...p, score: 1 }))
  assert.ok(passages.length > 1)
  await runResponseAgent(llm, { business: 'MM', question: q, passages, tier: 'primary' })
  await runResponseAgent(llm, { business: 'MM', question: q, passages, tier: 'small' })
  const ctxLines = (r: LlmRequest) => r.messages[1].content.split('\n').filter((l) => /^\[/.test(l)).length
  assert.equal(ctxLines(seen[0]), passages.length)
  assert.equal(ctxLines(seen[1]), 1)
  assert.equal(seen[0].maxTokens, 120)
  assert.equal(seen[1].maxTokens, 80)
  assert.equal(seen[1].tier, 'small')
})
