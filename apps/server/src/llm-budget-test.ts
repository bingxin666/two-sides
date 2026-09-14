/** Isolated regression runner (no external network or repository .env reads):
 * bun --no-env-file run apps/server/src/llm-budget-test.ts
 * The env module is replaced before any production module is imported. */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { mock } from 'bun:test'

const scratch = mkdtempSync(join(tmpdir(), 'two-sides-llm-budget-'))
const configPath = join(scratch, 'providers.json')
const credential = 'private-test-credential-never-log'
const testKeyName = 'TWO_SIDES_BUDGET_TEST_API_KEY'
const oldKey = process.env[testKeyName]
const oldLogLevel = process.env.LOG_LEVEL
const oldFailoverThreshold = process.env.LLM_FAILOVER_THRESHOLD
process.env[testKeyName] = credential
process.env.LOG_LEVEL = 'info'
process.env.LLM_FAILOVER_THRESHOLD = '3'
writeFileSync(configPath, JSON.stringify({
  providers: [
    { name: 'primary', baseUrl: 'https://primary.invalid/v1', apiKeyEnv: testKeyName },
    { name: 'backup', baseUrl: 'https://backup.invalid/v1', apiKeyEnv: testKeyName },
  ],
  agents: {
    extract: { provider: 'primary', model: 'test', fallback: { provider: 'backup', model: 'test' } },
    orient: { provider: 'primary', model: 'test', fallback: { provider: 'primary', model: 'test' } },
    summary: { provider: 'primary', model: 'test', fallback: { provider: 'backup', model: 'test' } },
    expand: { provider: 'primary', model: 'test', fallback: { provider: 'backup', model: 'test' } },
    merge: { provider: 'primary', model: 'test', thinking: 'disabled', fallback: { provider: 'backup', model: 'test' } },
    rescue: { provider: 'primary', model: 'test', fallback: { provider: 'backup', model: 'test' } },
    summaryFallback: { provider: 'primary', model: 'test', fallback: { provider: 'backup', model: 'test' } },
  },
}))
mock.module('./env', () => ({ env: { LLM_RPM_LIMIT: 100_000, PROVIDERS_CONFIG: configPath, LLM_REASONING_EFFORT: 'low' },
  hasEnv: (name: string) => !!process.env[name],
  zhihuSecretStatus: () => ({ configured: false, length: 0, sha256: '' }) }))
mock.module('./zhihu/title', () => ({ resolveQuestionTitle: () => { throw new Error('unexpected title/DB access') },
  rememberHint: () => { throw new Error('unexpected title/DB access') } }))

const { chat, LlmError, llmCounters } = await import('./llm/client')
const { callAgent } = await import('./llm/provider')
const { TokenBucket, TokenWaitError, llmBucket } = await import('./ratelimit')
const { log } = await import('./log')
const { expandQueries } = await import('./llm/expand')
const { createLlmAgents } = await import('./agents/llm')
const originalFetch = globalThis.fetch
const originalTake = llmBucket.take
const originalRandom = Math.random
const originalLog = console.log
const originalWarn = console.warn
const captured: string[] = []
console.log = (value: unknown) => captured.push(String(value))
console.warn = (value: unknown) => captured.push(String(value))
Math.random = () => 0
let requests: string[] = []
let fetcher: (url: string, init?: RequestInit) => Promise<Response> = async () => { throw new Error('unexpected mocked request') }
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  requests.push(String(url))
  return fetcher(String(url), init)
}) as typeof fetch
const base = { apiKey: credential, baseUrl: 'https://primary.invalid/v1', model: 'test',
  messages: [{ role: 'user' as const, content: 'test input' }] }
function response(content = 'ok', totalTokens = 5): Response {
  return Response.json({ choices: [{ message: { content } }],
    usage: { prompt_tokens: totalTokens - 2, completion_tokens: 2, total_tokens: totalTokens } })
}
async function expectError(fn: () => Promise<unknown>, kind: InstanceType<typeof LlmError>['kind']) {
  try { await fn() } catch (e) {
    assert(e instanceof LlmError)
    assert.equal(e.kind, kind)
    return e
  }
  throw new Error(`expected ${kind}`)
}
const checks: string[] = []
async function check(name: string, run: () => Promise<void>) {
  requests = []
  llmBucket.take = originalTake
  await run()
  checks.push(name)
}

try {
  await check('slow body read respects total deadline with one HTTP attempt', async () => {
    fetcher = async () => ({ ok: true, json: () => new Promise(() => {}) }) as unknown as Response
    const err = await expectError(() => chat({ ...base, deadlineAt: Date.now() + 50 }), 'timeout')
    assert.equal(requests.length, 1)
    assert.equal(err.stats.attempts, 1)
    assert(err.stats.latencyMs >= 35 && err.stats.latencyMs < 500)
  })
  await check('validation deadline retains billed tokens', async () => {
    fetcher = async () => response('sensitive-raw-content', 9)
    const err = await expectError(() => chat({ ...base, deadlineAt: Date.now() + 50,
      validate: () => new Promise(() => {}) }), 'timeout')
    assert.equal(err.stats.usage?.totalTokens, 9)
    assert.equal(err.stats.attempts, 1)
  })
  await check('synchronous validation cannot return success beyond the per-attempt timeout', async () => {
    fetcher = async () => response()
    await expectError(() => chat({ ...base, timeoutMs: 5, maxAttempts: 1, deadlineAt: Date.now() + 200,
      validate: () => { const end = Date.now() + 15; while (Date.now() < end) { /* block event loop */ } return true } }), 'timeout')
  })
  await check('backoff stops at the shared deadline without sending another request', async () => {
    fetcher = async () => new Response(credential, { status: 503 })
    const err = await expectError(() => chat({ ...base, deadlineAt: Date.now() + 50 }), 'timeout')
    assert.equal(requests.length, 1)
    assert.equal(err.stats.attempts, 1)
    assert(!err.message.includes(credential))
  })
  await check('capacity wait respects total deadline and reports zero sent attempts', async () => {
    const bucket = new TokenBucket(1, 0.01)
    bucket.tryTake()
    llmBucket.take = bucket.take.bind(bucket)
    const err = await expectError(() => chat({ ...base, deadlineAt: Date.now() + 50 }), 'timeout')
    assert.equal(requests.length, 0)
    assert.equal(err.stats.attempts, 0)
    assert(err.stats.rateLimitWaitMs >= 35)
  })
  await check('capacity wait supports cancellation and the old take(cost) API', async () => {
    const bucket = new TokenBucket(1, 0.01)
    assert((await bucket.take(1)) >= 0)
    const controller = new AbortController()
    const pending = bucket.take(1, { signal: controller.signal })
    controller.abort()
    await assert.rejects(pending, (e) => e instanceof TokenWaitError && e.kind === 'aborted')
  })
  await check('external cancellation never invokes a fallback', async () => {
    const controller = new AbortController()
    fetcher = async () => { controller.abort(); return new Promise(() => {}) }
    const err = await expectError(() => callAgent('extract', { messages: base.messages,
      signal: controller.signal, deadlineAt: Date.now() + 500 }), 'aborted')
    assert.equal(requests.length, 1)
    assert.equal(err.stats.attempts, 1)
  })
  await check('an expired call never touches a provider', async () => {
    const err = await expectError(() => callAgent('extract', { messages: base.messages, deadlineAt: Date.now() - 1 }), 'timeout')
    assert.equal(requests.length, 0)
    assert.equal(err.stats.attempts, 0)
  })
  await check('successful call latency includes body parsing and async validation', async () => {
    let sentSignal: AbortSignal | undefined
    fetcher = async (_url, init) => {
      sentSignal = init?.signal ?? undefined
      return { ok: true, json: async () => {
        await new Promise((resolve) => setTimeout(resolve, 25))
        return { choices: [{ message: { content: 'valid' } }], usage: { total_tokens: 5 } }
      } } as unknown as Response
    }
    const result = await chat({ ...base, deadlineAt: Date.now() + 500, validate: async (raw) => {
      await new Promise((resolve) => setTimeout(resolve, 25))
      return raw
    } })
    assert(result.latencyMs >= 40)
    assert.equal(result.attempts, 1)
    assert.equal(sentSignal?.aborted, true)
  })
  await check('provider sends configured low reasoning effort', async () => {
    fetcher = async (_url, init) => {
      assert.equal(JSON.parse(String(init?.body)).reasoning_effort, 'low')
      assert.equal(JSON.parse(String(init?.body)).thinking, undefined)
      return response('ok', 5)
    }
    const result = await callAgent('extract', { messages: base.messages, deadlineAt: Date.now() + 500,
      context: { qid: 'reasoning', date: '2026-09-13', stage: 'extract', unit: 'reasoning-test' } })
    assert.equal(result.content, 'ok')
  })
  await check('model-specific thinking is applied only to its configured provider path', async () => {
    fetcher = async (url, init) => {
      const body = JSON.parse(String(init?.body))
      if (url.includes('primary')) {
        assert.deepEqual(body.thinking, { type: 'disabled' })
        return new Response('', { status: 503 })
      }
      assert.equal(body.thinking, undefined)
      return response('ok')
    }
    const result = await callAgent('merge', { messages: base.messages, maxAttempts: 2, deadlineAt: Date.now() + 1500 })
    assert.equal(result.content, 'ok')
    assert.equal(result.attempts, 2)
  })
  await check('token-truncated responses retry even when partial content is valid JSON', async () => {
    let validations = 0
    fetcher = async () => requests.length === 1
      ? Response.json({ choices: [{ finish_reason: 'length', message: { content: '{"topics":[]}' } }],
        usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 } })
      : response('{"topics":["complete"]}', 5)
    const result = await chat({ ...base, maxTokens: 10, maxAttempts: 2, deadlineAt: Date.now() + 2000,
      validate: (raw) => { validations++; return JSON.parse(raw) } })
    assert.equal(result.attempts, 2)
    assert.equal(result.usage?.totalTokens, 20)
    assert.equal(validations, 1)
    assert.deepEqual(result.content, { topics: ['complete'] })
  })
  await check('shared three attempts include two primary calls and one fallback', async () => {
    const tokenStart = llmCounters.tokens
    fetcher = async (url) => response(url.includes('primary') ? 'invalid' : 'valid', 7)
    const result = await callAgent('extract', { messages: base.messages, deadlineAt: Date.now() + 2500,
      context: { qid: '42', date: '2026-09-13', stage: 'extract', unit: 'batch-1' },
      validate: (value) => { if (value === 'invalid') throw new Error(credential); return value } })
    assert.equal(result.path, 'fallback')
    assert.deepEqual(requests.map((url) => new URL(url).hostname), ['primary.invalid', 'primary.invalid', 'backup.invalid'])
    assert.equal(result.attempts, 3)
    assert.equal(result.usage?.totalTokens, 21)
    assert.equal(llmCounters.tokens - tokenStart, 21)
    assert(result.latencyMs >= 450)
  })
  await check('same provider/model fallback is not called twice for nonretryable HTTP failures', async () => {
    fetcher = async () => new Response(credential, { status: 400 })
    const err = await expectError(() => callAgent('orient', { messages: base.messages }), 'http')
    assert.equal(requests.length, 1)
    assert.equal(err.stats.attempts, 1)
    assert.equal(err.status, 400)
  })
  await check('an explicit maxAttempts one forbids retries or fallback', async () => {
    fetcher = async () => { throw new Error(`Authorization: Bearer ${credential}`) }
    const err = await expectError(() => callAgent('summary', { messages: base.messages, maxAttempts: 1 }), 'network')
    assert.equal(requests.length, 1)
    assert.equal(err.stats.attempts, 1)
    assert(!err.message.includes(credential))
  })
  await check('a provider total deadline blocks fallback after a slow body', async () => {
    fetcher = async () => ({ ok: true, json: () => new Promise(() => {}) }) as unknown as Response
    const err = await expectError(() => callAgent('extract', { messages: base.messages,
      deadlineAt: Date.now() + 50 }), 'timeout')
    assert.equal(requests.length, 1)
    assert.equal(err.stats.attempts, 1)
  })
  await check('implicit total budget includes backoff and is finite', async () => {
    fetcher = async () => new Response('', { status: 503 })
    const err = await expectError(() => callAgent('extract', { messages: base.messages, timeoutMs: 20 }), 'timeout')
    assert.equal(requests.length, 1)
    assert(err.stats.latencyMs >= 40 && err.stats.latencyMs < 500)
  })
  await check('expandQueries timeoutMs bounds the whole expansion and falls back to its original query', async () => {
    fetcher = async () => ({ ok: true, json: () => new Promise(() => {}) }) as unknown as Response
    const start = performance.now()
    const queries = await expandQueries('原始问题是什么？', { timeoutMs: 50 })
    assert.deepEqual(queries, ['原始问题是什么？'])
    assert.equal(requests.length, 1)
    assert(performance.now() - start < 500)
  })
  await check('expandQueries cancellation returns the original query with no fallback attempt', async () => {
    const controller = new AbortController()
    fetcher = async () => { controller.abort(); return new Promise(() => {}) }
    assert.deepEqual(await expandQueries('原始问题是什么？', { timeoutMs: 500,
      signal: controller.signal }), ['原始问题是什么？'])
    assert.equal(requests.length, 1)
  })
  await check('summarize sends max_tokens 1200 and retries a transient HTTP error', async () => {
    fetcher = async (_url, init) => {
      assert.equal(JSON.parse(String(init?.body)).max_tokens, 1200)
      return requests.length === 1 ? new Response(credential, { status: 503 }) : response('已恢复的综述')
    }
    const ctx = { qid: '42', date: '2026-09-13', signal: new AbortController().signal,
      deadlineAt: Date.now() + 2500, report() {}, note() {} }
    const result = await createLlmAgents().summarize([], [], ctx)
    assert.equal(result.summary, '已恢复的综述')
    assert.equal(result.source, 'liukanshan')
    assert.equal(requests.length, 2)
    assert(requests.every((url) => new URL(url).hostname === 'primary.invalid'))
  })
  await check('summarize retries an empty response instead of accepting missing content', async () => {
    fetcher = async () => response(requests.length === 1 ? '  ' : '有效综述')
    const ctx = { qid: '42', date: '2026-09-13', signal: new AbortController().signal,
      deadlineAt: Date.now() + 2500, report() {}, note() {} }
    const result = await createLlmAgents().summarize([], [], ctx)
    assert.equal(result.summary, '有效综述')
    assert.equal(requests.length, 2)
  })
  await check('summarize slow body respects the pipeline context deadline', async () => {
    fetcher = async () => ({ ok: true, json: () => new Promise(() => {}) }) as unknown as Response
    const ctx = { qid: '42', date: '2026-09-13', signal: new AbortController().signal,
      deadlineAt: Date.now() + 50, report() {}, note() {} }
    const err = await expectError(() => createLlmAgents().summarize([], [], ctx), 'timeout')
    assert.equal(requests.length, 1)
    assert(err.stats.latencyMs >= 35 && err.stats.latencyMs < 500)
  })
  await check('logs retain exact numeric token metrics and redact string/nested credentials', async () => {
    log.warn('redaction.test', { tokens: 12, totalTokens: 'credential', apiKey: credential,
      numericToken: 123, access_token: 123, nested: { authorization: credential, totalTokens: 14,
        prompt_tokens: 10, values: [{ cookie: credential, tokens: credential }] } })
    const entry = JSON.parse(captured.at(-1)!)
    assert.equal(entry.tokens, 12)
    assert.equal(entry.totalTokens, '[redacted]')
    assert.equal(entry.numericToken, '[redacted]')
    assert.equal(entry.access_token, '[redacted]')
    assert.equal(entry.nested.totalTokens, 14)
    assert.equal(entry.nested.prompt_tokens, 10)
    assert.equal(entry.nested.values[0].tokens, '[redacted]')
    assert(!captured.join('\n').includes(credential))
    assert(!captured.join('\n').includes('sensitive-raw-content'))
    const httpLog = captured.map((line) => JSON.parse(line)).find((line) => line.msg === 'llm.call.fail' && line.kind === 'http' && line.agent === 'orient')
    assert.equal(httpLog.status, 400)
    const callLog = captured.map((line) => JSON.parse(line)).find((line) => line.msg === 'llm.call.ok' && line.qid === '42' && line.attempts === 3)
    assert.equal(callLog.qid, '42')
    assert.equal(callLog.attempts, 3)
    assert.equal(callLog.tokens, 21)
  })
  await check('three sent timeout requests route the next call to fallback', async () => {
    // Dedicated agent: these failure counters never affect the preceding cases.
    fetcher = async () => ({ ok: true, json: () => new Promise(() => {}) }) as unknown as Response
    for (let index = 0; index < 3; index++) {
      const controller = new AbortController()
      const deadlineAt = Date.now() + 30
      // Exercise the phase timer's abort at the deadline as well as ordinary timeouts.
      const timer = index === 2 ? setTimeout(() => controller.abort(), 30) : undefined
      try {
        const err = await expectError(() => callAgent('merge', { messages: base.messages,
          deadlineAt, signal: controller.signal }), 'timeout')
        assert.equal(err.stats.attempts, 1)
      } finally {
        if (timer) clearTimeout(timer)
      }
      assert.equal(new URL(requests.at(-1)!).hostname, 'primary.invalid')
    }
    fetcher = async () => response()
    const result = await callAgent('merge', { messages: base.messages, deadlineAt: Date.now() + 500 })
    assert.equal(result.path, 'fallback')
    assert.equal(new URL(requests.at(-1)!).hostname, 'backup.invalid')
    assert.equal(requests.length, 4)
  })
  await check('three capacity-only timeouts do not count as provider failures', async () => {
    const bucket = new TokenBucket(1, 0.01)
    bucket.tryTake()
    llmBucket.take = bucket.take.bind(bucket)
    for (let index = 0; index < 3; index++) {
      const err = await expectError(() => callAgent('rescue', { messages: base.messages,
        deadlineAt: Date.now() + 25 }), 'timeout')
      assert.equal(err.stats.attempts, 0)
    }
    assert.equal(requests.length, 0)
    llmBucket.take = originalTake
    fetcher = async () => response()
    const result = await callAgent('rescue', { messages: base.messages, deadlineAt: Date.now() + 500 })
    assert.equal(result.path, 'primary')
    assert.equal(new URL(requests[0]!).hostname, 'primary.invalid')
  })
  await check('three early external cancellations do not count as provider failures', async () => {
    for (let index = 0; index < 3; index++) {
      const controller = new AbortController()
      fetcher = async () => { controller.abort(); return new Promise(() => {}) }
      await expectError(() => callAgent('summaryFallback', { messages: base.messages,
        deadlineAt: Date.now() + 500, signal: controller.signal }), 'aborted')
    }
    fetcher = async () => response()
    const result = await callAgent('summaryFallback', { messages: base.messages, deadlineAt: Date.now() + 500 })
    assert.equal(result.path, 'primary')
    assert.equal(requests.length, 4)
    assert(requests.every((url) => new URL(url).hostname === 'primary.invalid'))
  })
} finally {
  globalThis.fetch = originalFetch
  llmBucket.take = originalTake
  Math.random = originalRandom
  console.log = originalLog
  console.warn = originalWarn
  if (oldKey === undefined) delete process.env[testKeyName]
  else process.env[testKeyName] = oldKey
  if (oldLogLevel === undefined) delete process.env.LOG_LEVEL
  else process.env.LOG_LEVEL = oldLogLevel
  if (oldFailoverThreshold === undefined) delete process.env.LLM_FAILOVER_THRESHOLD
  else process.env.LLM_FAILOVER_THRESHOLD = oldFailoverThreshold
  assert.equal(dirname(resolve(scratch)), resolve(tmpdir()))
  assert.ok(basename(scratch).startsWith('two-sides-llm-budget-'))
  rmSync(scratch, { recursive: true, force: true })
}
for (const name of checks) originalLog(`PASS ${name}`)
originalLog(`${checks.length} isolated LLM budget checks passed; no live network or repository env reads.`)
