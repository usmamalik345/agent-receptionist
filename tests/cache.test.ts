/** Response cache: LRU + TTL + stats, key = hash(normalized text) + business + policy; Redis via fake RESP server. */
import assert from 'node:assert/strict'
import net from 'node:net'
import { test } from 'node:test'
import { cacheKey, createResponseCache, encodeCommand, LruCache, parseReply, RedisCache } from '../server/cache.ts'

test('key: normalized text, business and policy version all matter; text is hashed', () => {
  const a = cacheKey('What are your HOURS?', 'mm-dental', 'v1')
  assert.equal(a, cacheKey('what are your hours', 'mm-dental', 'v1'))
  assert.notEqual(a, cacheKey('what are your hours', 'erth', 'v1'))
  assert.notEqual(a, cacheKey('what are your hours', 'mm-dental', 'v2'))
  assert.doesNotMatch(a, /hours/)
})

test('LRU: hit/miss stats, TTL expiry, eviction of least recently used', async () => {
  let now = 0
  const c = new LruCache(1000, 2, () => now)
  await c.set('a', '1')
  await c.set('b', '2')
  assert.equal(await c.get('a'), '1') // a is now most recent
  await c.set('c', '3') // evicts b
  assert.equal(await c.get('b'), null)
  now = 5000
  assert.equal(await c.get('a'), null) // expired
  const s = c.stats()
  assert.equal(s.hits, 1)
  assert.equal(s.misses, 2)
  assert.equal(s.backend, 'memory')
})

test('RESP encode/parse', () => {
  assert.equal(encodeCommand(['GET', 'k']), '*2\r\n$3\r\nGET\r\n$1\r\nk\r\n')
  assert.deepEqual(parseReply('$-1\r\n'), { value: null, rest: '' })
  assert.deepEqual(parseReply('$3\r\nabc\r\n+OK\r\n'), { value: 'abc', rest: '+OK\r\n' })
  assert.equal(parseReply('$3\r\nab'), null)
})

function fakeRedis(): Promise<{ port: number; store: Map<string, string>; close: () => void }> {
  const store = new Map<string, string>()
  const server = net.createServer((sock) => {
    let buf = ''
    sock.on('data', (d) => {
      buf += d.toString()
      // naive RESP array parser good enough for GET/SET
      for (;;) {
        const m = buf.match(/^\*(\d+)\r\n/)
        if (!m) return
        let rest = buf.slice(m[0].length)
        const args: string[] = []
        for (let i = 0; i < Number(m[1]); i++) {
          const h = rest.match(/^\$(\d+)\r\n/)
          if (!h || rest.length < h[0].length + Number(h[1]) + 2) return
          args.push(rest.slice(h[0].length, h[0].length + Number(h[1])))
          rest = rest.slice(h[0].length + Number(h[1]) + 2)
        }
        buf = rest
        const [cmd, k, v] = args
        if (cmd === 'GET') sock.write(store.has(k) ? `$${Buffer.byteLength(store.get(k)!)}\r\n${store.get(k)}\r\n` : '$-1\r\n')
        else if (cmd === 'SET') (store.set(k, v), sock.write('+OK\r\n'))
        else sock.write('-ERR unknown\r\n')
      }
    })
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as net.AddressInfo).port, store, close: () => server.close() })),
  )
}

test('Redis backend (fake RESP server): set then get = hit', async () => {
  const r = await fakeRedis()
  const c = new RedisCache(`redis://127.0.0.1:${r.port}`, 60_000)
  await c.set('k1', 'hello')
  assert.equal(r.store.get('k1'), 'hello')
  assert.equal(await c.get('k1'), 'hello')
  assert.equal(await c.get('nope'), null)
  assert.deepEqual({ ...c.stats(), sets: undefined }, { hits: 1, misses: 1, errors: 0, backend: 'redis', sets: undefined })
  await c.close()
  r.close()
})

test('Redis unreachable -> falls back to in-memory LRU, errors counted', async () => {
  const c = new RedisCache('redis://127.0.0.1:1', 60_000, { timeoutMs: 100 })
  await c.set('k', 'v')
  assert.equal(await c.get('k'), 'v')
  assert.ok(c.stats().errors >= 2)
  await c.close()
})

test('createResponseCache picks redis only when REDIS_URL is set', () => {
  assert.equal(createResponseCache({}).stats().backend, 'memory')
  assert.equal(createResponseCache({ REDIS_URL: 'redis://127.0.0.1:6379' }).stats().backend, 'redis')
})
