/** LLM client selection + OpenAI-compatible request shape. No network: fetch is stubbed. */
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createMockClient, loadLlmClient } from '../server/llm.ts'

const realFetch = globalThis.fetch
before(() => {
  // Any accidental real network call fails the test run.
  globalThis.fetch = (() => Promise.reject(new Error('network disabled in tests'))) as typeof fetch
})
after(() => {
  globalThis.fetch = realFetch
})

test('default provider is the offline mock', () => {
  const c = loadLlmClient({})
  assert.equal(c.provider, 'mock')
})

test('groq/gemini without LLM_API_KEY fall back to mock and say so', () => {
  for (const p of ['groq', 'gemini']) {
    const c = loadLlmClient({ LLM_PROVIDER: p })
    assert.equal(c.provider, 'mock')
    assert.match(c.note, /no LLM_API_KEY/)
  }
})

test('mock is deterministic and cites the first passage', async () => {
  const c = createMockClient()
  const req = { messages: [{ role: 'user' as const, content: 'CONTEXT:\n[faq:0] Q: New? A: Yes, welcome.\n\nCALLER: new?' }] }
  const a = await c.complete(req)
  const b = await c.complete(req)
  assert.equal(a.text, 'Yes, welcome. [faq:0]')
  assert.equal(a.text, b.text)
  assert.equal(a.usage.estimated, true)
})

test('mock latency is abortable (used by fault tests)', async () => {
  const c = createMockClient({ latencyMs: 5000 })
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 20)
  await assert.rejects(c.complete({ messages: [{ role: 'user', content: 'x' }], signal: ac.signal }), /aborted/)
})

test('groq request: endpoint, auth header, model, max_tokens; usage parsed', async () => {
  const calls: Array<{ url: string; init: { headers: Record<string, string>; body: string } }> = []
  const fakeFetch = async (url: string, init: { headers: Record<string, string>; body: string }) => {
    calls.push({ url, init })
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'Hi [faq:0]' } }], usage: { prompt_tokens: 42, completion_tokens: 7 } }),
      text: async () => '',
    }
  }
  const c = loadLlmClient({ LLM_PROVIDER: 'groq', LLM_API_KEY: 'test-key-not-real' }, fakeFetch as never)
  assert.equal(c.provider, 'groq')
  const r = await c.complete({ messages: [{ role: 'user', content: 'hello' }], maxTokens: 50, tier: 'small' })
  assert.equal(calls[0].url, 'https://api.groq.com/openai/v1/chat/completions')
  assert.equal(calls[0].init.headers.authorization, 'Bearer test-key-not-real')
  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.model, 'openai/gpt-oss-20b')
  assert.equal(body.max_tokens, 50)
  assert.deepEqual(r.usage, { prompt: 42, completion: 7, estimated: false })
})

test('gemini uses the OpenAI-compatible base URL; HTTP errors throw (ladder turns them into llm_error)', async () => {
  let url = ''
  const fakeFetch = async (u: string) => {
    url = u
    return { ok: false, status: 429, json: async () => ({}), text: async () => 'rate limited' }
  }
  const c = loadLlmClient({ LLM_PROVIDER: 'gemini', LLM_API_KEY: 'k' }, fakeFetch as never)
  await assert.rejects(c.complete({ messages: [{ role: 'user', content: 'x' }] }), /llm_http_429/)
  assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions')
})

test('openai-compatible (local Ollama) works without a key', () => {
  const c = loadLlmClient({ LLM_PROVIDER: 'openai-compatible', LLM_BASE_URL: 'http://localhost:11434/v1', LLM_MODEL: 'llama3.2:3b' })
  assert.equal(c.provider, 'openai-compatible')
  assert.equal(c.primaryModel, 'llama3.2:3b')
})
