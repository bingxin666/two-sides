/** OAuth 回归：独立配置、进程内 Hono 请求、模拟知乎响应，绝不访问真实账号或网络。 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'
import { Hono } from 'hono'

const originalCwd = process.cwd()
const tempRoot = resolve(tmpdir())
const testDir = mkdtempSync(resolve(tempRoot, 'two-sides-auth-test-'))
const originalFetch = globalThis.fetch
const originalNow = Date.now
const originalTimeout = AbortSignal.timeout

process.chdir(testDir)
writeFileSync(resolve(testDir, '.env'), '')
Object.assign(process.env, {
  ZHIDUAN_DB_PATH: resolve(testDir, 'test.db'),
  ZHIHU_ACCESS_SECRET: 'test-only-not-a-real-secret',
  ZHIHU_LIVE: '0',
  ZHIHU_OAUTH_APP_ID: 'test-app-id',
  ZHIHU_OAUTH_APP_KEY: 'test-only-key+&=非真实',
  ZHIHU_OAUTH_REDIRECT_URI: 'https://oauth-test.invalid/callback',
  PIPELINE_MODE: 'fake',
  PREGENERATE_TOP: '0',
  RECOVER_ON_BOOT: 'false',
  LOG_LEVEL: 'error',
})

type Exchange = { url: string; init: RequestInit }
const exchanges: Exchange[] = []
const TEST_TOKEN = 'test-only-user-token-never-a-real-token'
let respond: (init: RequestInit) => Promise<Response> = async () =>
  Response.json({ access_token: TEST_TOKEN, expires_in: 3600 })

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input)
  assert.equal(url, 'https://openapi.zhihu.com/access_token', 'unexpected network request blocked')
  assert.ok(init)
  exchanges.push({ url, init })
  return respond(init)
}) as typeof fetch

async function main(): Promise<void> {
  const { authRoutes, publicCallbackRoutes } = await import('./routes/auth')
  const app = new Hono()
  app.route('/api/v1', authRoutes)
  app.route('/callback', publicCallbackRoutes)

  let passed = 0
  async function check(name: string, run: () => Promise<void>): Promise<void> {
    exchanges.length = 0
    respond = async () => Response.json({ access_token: TEST_TOKEN, expires_in: 3600 })
    await run()
    passed++
    console.log(`ok - ${name}`)
  }

  function cookie(response: Response, name: string): string | undefined {
    return response.headers.getSetCookie().find((value) => value.startsWith(`${name}=`))
  }

  function secureCookie(value: string | undefined): asserts value is string {
    assert.ok(value, 'expected cookie')
    assert.match(value, /;\s*HttpOnly(?:;|$)/i)
    assert.match(value, /;\s*Secure(?:;|$)/i)
    assert.match(value, /;\s*SameSite=Lax(?:;|$)/i)
    assert.match(value, /;\s*Path=\/(?:;|$)/i)
  }

  async function authorize(): Promise<{ state: string; cookie: string }> {
    const response = await app.request('/api/v1/auth/zhihu/authorize')
    assert.equal(response.status, 302)
    const target = new URL(response.headers.get('location')!)
    assert.equal(target.origin + target.pathname, 'https://openapi.zhihu.com/authorize')
    assert.equal(target.searchParams.get('app_id'), 'test-app-id')
    assert.equal(target.searchParams.get('redirect_uri'), process.env.ZHIHU_OAUTH_REDIRECT_URI)
    assert.equal(target.searchParams.get('response_type'), 'code')
    assert.equal(target.searchParams.has('app_key'), false)
    const state = target.searchParams.get('state')!
    assert.match(state, /^[a-f0-9]{64}$/)
    const value = cookie(response, 'two_sides_zhihu_state')
    secureCookie(value)
    assert.match(value, /;\s*Max-Age=600(?:;|$)/i)
    assert.equal(value.split(';')[0], `two_sides_zhihu_state=${state}`)
    return { state, cookie: value.split(';')[0]! }
  }

  async function callback(
    login: { state: string; cookie: string },
    params: Record<string, string> = { authorization_code: 'test-only-code' },
    path = '/callback',
  ): Promise<Response> {
    const query = new URLSearchParams({ state: login.state, ...params })
    return app.request(`${path}?${query}`, { headers: { cookie: login.cookie } })
  }

  async function redirected(response: Response, ok: boolean): Promise<void> {
    assert.equal(response.status, 302)
    assert.equal(response.headers.get('location'), ok ? '/?oauth=success' : '/?oauth=error')
    const headerPairs: string[][] = []
    response.headers.forEach((value, key) => headerPairs.push([key, value]))
    const outward = `${JSON.stringify(headerPairs)}\n${await response.text()}`
    assert.equal(outward.includes(TEST_TOKEN), false)
    assert.equal(outward.includes(process.env.ZHIHU_OAUTH_APP_KEY!), false)
    assert.equal(outward.includes('test-only-code'), false)
    if (!ok) {
      const sessionCookie = cookie(response, 'two_sides_zhihu_session')
      assert.ok(!sessionCookie || sessionCookie.startsWith('two_sides_zhihu_session=;'))
    }
  }

  for (const [path, parameter] of [
    ['/callback', 'authorization_code'],
    ['/api/v1/auth/zhihu/callback', 'code'],
  ] as const) {
    await check(`${path}: successful ${parameter} exchange and opaque session`, async () => {
      const login = await authorize()
      const code = 'test-only-code +&=中文'
      const response = await callback(login, { [parameter]: code }, path)
      await redirected(response, true)
      assert.equal(exchanges.length, 1)
      const exchange = exchanges[0]!.init
      assert.equal(exchange.method, 'POST')
      assert.equal(new Headers(exchange.headers).get('content-type'), 'application/x-www-form-urlencoded')
      assert.ok(exchange.body instanceof URLSearchParams)
      assert.deepEqual(Object.fromEntries(exchange.body), {
        app_id: 'test-app-id',
        app_key: process.env.ZHIHU_OAUTH_APP_KEY,
        grant_type: 'authorization_code',
        redirect_uri: process.env.ZHIHU_OAUTH_REDIRECT_URI,
        code,
      })
      assert.ok(exchange.signal instanceof AbortSignal, 'token exchange must have an abort deadline')
      const sessionCookie = cookie(response, 'two_sides_zhihu_session')
      secureCookie(sessionCookie)
      assert.match(sessionCookie, /^two_sides_zhihu_session=[a-f0-9]{64};/)
      assert.match(sessionCookie, /;\s*Max-Age=3600(?:;|$)/i)
      const status = await app.request('/api/v1/auth/zhihu/status', {
        headers: { cookie: sessionCookie.split(';')[0]! },
      })
      const payload = await status.json() as { data: { authorized: boolean } }
      assert.equal(payload.data.authorized, true)
    })
  }

  await check('missing state cannot exchange a code', async () => {
    await redirected(await app.request('/callback?authorization_code=test-only-code'), false)
    assert.equal(exchanges.length, 0)
  })

  await check('unknown state cannot exchange a code', async () => {
    await redirected(await callback({ state: 'unknown-state', cookie: 'two_sides_zhihu_state=unknown-state' }), false)
    assert.equal(exchanges.length, 0)
  })

  await check('missing or mismatched cookie does not consume the legitimate pending state', async () => {
    const login = await authorize()
    await redirected(await callback({ ...login, cookie: '' }), false)
    await redirected(await callback({ ...login, cookie: 'two_sides_zhihu_state=wrong-state' }), false)
    assert.equal(exchanges.length, 0)
    await redirected(await callback(login), true)
    assert.equal(exchanges.length, 1)
  })

  await check('expired state cannot exchange a code', async () => {
    const login = await authorize()
    const now = Date.now()
    Date.now = () => now + 600_001
    try {
      await redirected(await callback(login), false)
      assert.equal(exchanges.length, 0)
    } finally {
      Date.now = originalNow
    }
  })

  await check('successful state cannot be replayed', async () => {
    const login = await authorize()
    await redirected(await callback(login), true)
    await redirected(await callback(login), false)
    assert.equal(exchanges.length, 1)
  })

  await check('missing code redirects without a token exchange', async () => {
    await redirected(await callback(await authorize(), {}), false)
    assert.equal(exchanges.length, 0)
  })

  await check('provider denial redirects without a token exchange', async () => {
    await redirected(await callback(await authorize(), { error: 'access_denied' }), false)
    assert.equal(exchanges.length, 0)
  })

  for (const [name, failure] of [
    ['non-2xx, even with a token', async () => Response.json({ access_token: TEST_TOKEN }, { status: 503 })],
    ['invalid JSON', async () => new Response('{not-json', { headers: { 'content-type': 'application/json' } })],
    ['missing token', async () => Response.json({ error: 'invalid_grant' })],
    ['empty token', async () => Response.json({ access_token: '' })],
    ['network failure', async () => { throw new TypeError('test-only network failure') }],
  ] as const) {
    await check(`${name}: safe error redirect, no code replay`, async () => {
      const login = await authorize()
      respond = failure
      await redirected(await callback(login), false)
      await redirected(await callback(login), false)
      assert.equal(exchanges.length, 1)
    })
  }

  for (const phase of ['headers', 'body'] as const) {
    await check(`15-second deadline covers token response ${phase}`, async () => {
      const login = await authorize()
      const requestedDeadlines: number[] = []
      AbortSignal.timeout = (milliseconds: number) => {
        requestedDeadlines.push(milliseconds)
        const controller = new AbortController()
        setTimeout(() => controller.abort(new DOMException('test-only timeout', 'TimeoutError')), 5)
        return controller.signal
      }
      const waitForAbort = (signal: AbortSignal): Promise<never> => new Promise((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason)
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
      respond = async (init) => {
        assert.ok(init.signal instanceof AbortSignal)
        if (phase === 'headers') return waitForAbort(init.signal)
        const response = Response.json({ access_token: TEST_TOKEN })
        response.json = () => waitForAbort(init.signal as AbortSignal)
        return response
      }
      let guard: ReturnType<typeof setTimeout> | undefined
      try {
        const response = await Promise.race([
          callback(login),
          new Promise<never>((_resolve, reject) => {
            guard = setTimeout(() => reject(new Error('callback ignored its abort deadline')), 1000)
          }),
        ])
        await redirected(response, false)
        assert.deepEqual(requestedDeadlines, [15_000])
        assert.equal(exchanges.length, 1)
      } finally {
        if (guard) clearTimeout(guard)
        AbortSignal.timeout = originalTimeout
      }
    })
  }

  console.log(`auth tests passed (${passed} cases; zero real network requests)`)
}

try {
  await main()
} finally {
  globalThis.fetch = originalFetch
  Date.now = originalNow
  AbortSignal.timeout = originalTimeout
  process.chdir(originalCwd)
  assert.equal(dirname(testDir), tempRoot)
  assert.ok(basename(testDir).startsWith('two-sides-auth-test-'))
  rmSync(testDir, { recursive: true, force: true })
}
