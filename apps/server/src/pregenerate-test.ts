/** Startup hot-list regression checks: temporary SQLite, fake agents, no network. */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'

const scenario = process.argv[process.argv.indexOf('--case') + 1] ?? 'all'
const testCase = process.argv.includes('--case') ? scenario : 'all'
const originalCwd = process.cwd()
const tempRoot = resolve(tmpdir())
const testDir = mkdtempSync(resolve(tempRoot, 'two-sides-pregenerate-test-'))
const originalFetch = globalThis.fetch
const originalNow = Date.now
const nativeSetTimeout = globalThis.setTimeout
let clock = Date.parse('2026-09-13T04:00:00Z')
let closeDatabase: (() => void) | undefined

// All runtime configuration precedes imports that snapshot env.ts. An empty local
// .env also prevents its fallback loader from reading the repository's real .env.
process.chdir(testDir)
writeFileSync(resolve(testDir, '.env'), '')
Object.assign(process.env, {
  ZHIDUAN_DB_PATH: resolve(testDir, 'test.db'),
  ZHIHU_LIVE: testCase === 'disabled' ? '0' : '1',
  ZHIHU_ACCESS_SECRET: 'test-only-not-a-real-secret',
  PIPELINE_MODE: 'fake',
  PIPELINE_FAKE_DURATION_MS: '0',
  PREGENERATE_TOP: testCase === 'top-zero' ? '0' : '3',
  PREGENERATE_CONCURRENCY: '2',
  ANALYSIS_JOB_TIMEOUT_SEC: '1',
  RECOVER_ON_BOOT: 'false',
  LOG_LEVEL: 'error',
})
Date.now = () => clock

let fetchCount = 0
let responseQids = ['1001', '1002', '1003']
let failFetch = false
let fetchGate: Promise<void> | undefined
const unexpectedRequests: string[] = []
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  fetchCount++
  if (url.origin !== 'https://developer.zhihu.com' || url.pathname !== '/api/v1/content/hot_list') {
    unexpectedRequests.push(`${url.origin}${url.pathname}`)
    throw new Error('Unexpected network request blocked by test')
  }
  await fetchGate
  if (failFetch) throw new Error('test offline')
  return Response.json({
    Code: 0,
    Data: { Items: responseQids.map((qid) => ({ Title: `测试问题 ${qid} - 知乎`, Url: `https://www.zhihu.com/question/${qid}` })) },
  })
}) as typeof fetch

interface ScheduledTimer { delay: number; fire: () => void }

/** Capture cron/recovery timers; short fake-agent and job timers run normally. */
async function withScheduledTimers(run: (timers: ScheduledTimer[]) => Promise<void>): Promise<void> {
  const timers: ScheduledTimer[] = []
  const handles: Array<ReturnType<typeof setTimeout>> = []
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay = 0, ...args: unknown[]) => {
    if (delay <= 1000) return nativeSetTimeout(callback, delay, ...args)
    timers.push({ delay, fire: () => callback(...args) })
    const handle = nativeSetTimeout(() => {}, 2_147_483_647)
    handle.unref()
    handles.push(handle)
    return handle
  }) as typeof setTimeout
  try {
    await run(timers)
  } finally {
    globalThis.setTimeout = nativeSetTimeout
    for (const handle of handles) clearTimeout(handle)
  }
}

async function eventually(check: () => boolean): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (check()) return
    await new Promise<void>((resolvePromise) => nativeSetTimeout(resolvePromise, 5))
  }
  assert.fail('Background work did not finish')
}

async function main(): Promise<void> {
  const { pregenerate, pregenerateOnBoot, startPregenerateCron, msUntilNextPregenerate } = await import('./pregenerate')
  const { getDb, closeDb } = await import('./db')
  const repo = await import('./repo')
  const { env } = await import('./env')
  const { todayKey, shiftDateKey, nowIso } = await import('./time')
  const { generateFakeAnalysis } = await import('./agents/fake')
  const { STALE_GRACE_MS, isRunningHere } = await import('./jobs')
  const { hotRoutes } = await import('./routes/hot')
  closeDatabase = closeDb
  const db = getDb()
  const date = todayKey()
  let passed = 0

  function reset(): void {
    for (const table of ['jobs', 'analyses', 'hot_questions', 'question_titles']) db.exec(`DELETE FROM ${table}`)
    fetchCount = 0
    failFetch = false
    fetchGate = undefined
    responseQids = ['1001', '1002', '1003']
    assert.deepEqual(unexpectedRequests, [])
  }

  function seed(qid: string, status: 'missing' | 'ready' | 'failed' | 'generating', day = date): void {
    repo.upsertHotQuestions(day, [{ date: day, qid, title: `本地问题 ${qid}`, url: `https://www.zhihu.com/question/${qid}`, fetched_at: nowIso() }])
    if (status === 'missing') return
    repo.beginRun(day, qid, 1)
    const id = `test-${day}-${qid}`
    repo.insertJobIgnore({ id, date: day, qid, stage: 'extract', attempts: 1, owner: 'previous-process' })
    if (status === 'ready') {
      repo.markReady(id, day, qid, JSON.stringify(generateFakeAnalysis(qid, day)), {
        stage: 'render', stageRatio: 1, sampleCount: 0, judgmentsDone: 0, judgmentsTotal: 0,
      })
    } else if (status === 'failed') {
      repo.markFailed(id, day, qid, 1, { code: 'llm_error', message: 'test failure', stage: 'extract', retryable: true })
    } else {
      repo.setAnalysisStatus(day, qid, 'generating', 1)
      repo.setJobStatus(id, day, qid, 'generating')
    }
  }

  async function check(name: string, run: () => Promise<void>): Promise<void> {
    reset()
    await run()
    assert.deepEqual(unexpectedRequests, [])
    passed++
    console.log(`ok ${passed} - ${name}`)
  }

  if (testCase === 'index-nonblocking') {
    let release!: () => void
    fetchGate = new Promise<void>((resolvePromise) => { release = resolvePromise })
    await withScheduledTimers(async () => {
      let deadline!: ReturnType<typeof setTimeout>
      try {
        const { default: server } = await Promise.race([
          import('./index'),
          new Promise<never>((_, reject) => {
            deadline = nativeSetTimeout(() => reject(new Error('index import waited for hot_list')), 2000)
          }),
        ])
        assert.equal(fetchCount, 1)
        const response = await server.fetch(new Request('http://localhost/api/v1/hot'))
        assert.equal(response.status, 404)
      } finally {
        clearTimeout(deadline)
        release()
        // Let the background batch settle before closing the temporary database.
        await pregenerate(3, { reuseStored: true })
      }
    })
    assert.equal(repo.listReadyHot(date).length, 3)
    assert.deepEqual(unexpectedRequests, [])
    console.log('ok - index-nonblocking: index exports HTTP while startup hot_list is pending')
    return
  }

  if (testCase !== 'all') {
    assert.ok(testCase === 'disabled' || testCase === 'top-zero')
    await pregenerateOnBoot()
    assert.equal(fetchCount, 0)
    assert.deepEqual(repo.listHotQuestions(date), [])
    assert.equal(db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM jobs').get()?.count, 0)
    console.log(`ok - ${testCase}: startup skipped without network or jobs`)
    return
  }

  await check('missing daily list fetches once and persists candidates plus valid ready analyses', async () => {
    await pregenerateOnBoot()
    assert.equal(fetchCount, 1)
    assert.deepEqual(repo.listHotQuestions(date).map((row) => row.qid), responseQids)
    for (const qid of responseQids) {
      assert.equal(repo.getAnalysis(date, qid)?.status, 'ready')
      assert.equal(JSON.parse(repo.getAnalysis(date, qid)!.data!).qid, qid)
      assert.equal(repo.getQuestionTitle(qid)?.title, `测试问题 ${qid}`)
    }
    assert.equal(repo.listReadyHot(date).length, 3)
    assert.equal((await hotRoutes.request('/hot')).status, 200)
  })

  await check('complete local daily list skips every job and network request', async () => {
    for (const qid of responseQids) seed(qid, 'ready')
    const before = responseQids.map((qid) => repo.getAnalysis(date, qid))
    const report = await pregenerate(3, { reuseStored: true })
    assert.equal(report.skippedReady, 3)
    assert.equal(report.started, 0)
    assert.equal(fetchCount, 0)
    assert.deepEqual(responseQids.map((qid) => repo.getAnalysis(date, qid)), before)
  })

  await check('partial local list fills only missing analyses and preserves failed attempts', async () => {
    seed('2001', 'ready')
    seed('2002', 'failed')
    seed('2003', 'missing')
    const failed = repo.getAnalysis(date, '2002')
    const report = await pregenerate(3, { reuseStored: true })
    assert.equal(fetchCount, 0)
    assert.equal(report.skippedReady, 1)
    assert.equal(report.skippedFailed, 1)
    assert.equal(report.started, 1)
    assert.deepEqual(repo.getAnalysis(date, '2002'), failed)
    assert.equal(repo.getAnalysis(date, '2003')?.status, 'ready')
    assert.equal(repo.getQuestionTitle('2003')?.title, '本地问题 2003')
  })

  await check('yesterday data does not suppress generation for the Shanghai date', async () => {
    const yesterday = shiftDateKey(date, -1)
    seed('3001', 'ready', yesterday)
    await pregenerateOnBoot()
    assert.equal(fetchCount, 1)
    assert.equal(repo.listReadyHot(date).length, 3)
    assert.equal(repo.listReadyHot(yesterday).length, 1)
    assert.equal(todayKey(Date.parse('2026-09-12T15:59:59Z')), '2026-09-12')
    assert.equal(todayKey(Date.parse('2026-09-12T16:00:00Z')), '2026-09-13')
    assert.equal(msUntilNextPregenerate(Date.parse('2026-09-12T16:29:59Z')), 1000)
  })

  await check('startup and actual cron callback share one batch while HTTP remains responsive', async () => {
    let release!: () => void
    fetchGate = new Promise<void>((resolvePromise) => { release = resolvePromise })
    await withScheduledTimers(async (timers) => {
      let bootDone = false
      const boot = pregenerateOnBoot().then(() => { bootDone = true })
      startPregenerateCron()
      assert.equal(timers.length, 1)
      timers[0]!.fire()
      const first = pregenerate(3, { reuseStored: true })
      assert.equal(pregenerate(3, { reuseStored: true }), first)
      assert.equal(fetchCount, 1)
      assert.equal((await hotRoutes.request('/hot')).status, 404)
      assert.equal(bootDone, false)
      release()
      await Promise.all([boot, first])
      await eventually(() => timers.length === 2)
      assert.equal(fetchCount, 1)
      assert.equal(repo.listReadyHot(date).length, 3)
      for (const qid of responseQids) assert.equal(repo.getAnalysis(date, qid)?.attempts, 1)
    })
  })

  await check('fetch failure releases the batch and boot catches failures before a later retry', async () => {
    failFetch = true
    await assert.rejects(pregenerate(3, { reuseStored: true }), /test offline/)
    await assert.doesNotReject(pregenerateOnBoot())
    assert.equal(fetchCount, 2)
    assert.deepEqual(repo.listHotQuestions(date), [])
    failFetch = false
    await pregenerateOnBoot()
    assert.equal(fetchCount, 3)
    assert.equal(repo.listReadyHot(date).length, 3)
  })

  await check('stale generating job is resumed from local candidates without fetching', async () => {
    seed('4001', 'generating')
    const oldTime = nowIso(clock - env.JOB_TIMEOUT_SEC * 1000 - STALE_GRACE_MS - 1)
    db.query('UPDATE jobs SET updated_at = ? WHERE date = ? AND qid = ?').run(oldTime, date, '4001')
    await pregenerateOnBoot()
    assert.equal(fetchCount, 0)
    assert.equal(repo.getAnalysis(date, '4001')?.status, 'ready')
    assert.equal(repo.getAnalysis(date, '4001')?.attempts, 2)
  })

  await check('one delayed recheck resumes interrupted work without stealing active or failed jobs', async () => {
    for (const qid of ['5001', '5002', '5003']) seed(qid, 'generating')
    const beforeClock = clock
    try {
      await withScheduledTimers(async (timers) => {
        await pregenerateOnBoot()
        assert.equal(timers.length, 1)
        assert.equal(repo.getAnalysis(date, '5001')?.attempts, 1)
        assert.equal(timers[0]!.delay, env.JOB_TIMEOUT_SEC * 1000 + STALE_GRACE_MS + 1)
        clock += timers[0]!.delay
        db.query('UPDATE jobs SET updated_at = ? WHERE date = ? AND qid = ?').run(nowIso(), date, '5002')
        const third = repo.getJob(date, '5003')!
        repo.markFailed(third.id, date, '5003', 1, { code: 'llm_error', message: 'test failure', stage: 'extract', retryable: true })
        timers[0]!.fire()
        await eventually(() => repo.getAnalysis(date, '5001')?.status === 'ready' && !isRunningHere(date, '5001'))
        assert.equal(repo.getAnalysis(date, '5001')?.attempts, 2)
        assert.equal(repo.getAnalysis(date, '5002')?.status, 'generating')
        assert.equal(repo.getAnalysis(date, '5002')?.attempts, 1)
        assert.equal(repo.getAnalysis(date, '5003')?.status, 'failed')
        assert.equal(repo.getAnalysis(date, '5003')?.attempts, 1)
        assert.equal(timers.length, 1)
        assert.equal(fetchCount, 0)
      })
    } finally {
      clock = beforeClock
    }
  })

  for (const childCase of ['disabled', 'top-zero', 'index-nonblocking']) {
    const child = Bun.spawn([process.execPath, import.meta.path, '--case', childCase], {
      cwd: testDir, env: process.env, stdout: 'pipe', stderr: 'pipe',
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ])
    assert.equal(code, 0, `${childCase} failed: ${stderr}`)
    assert.equal(stderr, '')
    passed++
    console.log(stdout.trim())
  }
  console.log(`pregenerate tests passed (${passed} cases; zero real network requests)`)
}

try {
  await main()
} finally {
  closeDatabase?.()
  globalThis.fetch = originalFetch
  Date.now = originalNow
  globalThis.setTimeout = nativeSetTimeout
  process.chdir(originalCwd)
  // Only remove the exact temporary directory this invocation created.
  assert.equal(dirname(testDir), tempRoot)
  assert.ok(basename(testDir).startsWith('two-sides-pregenerate-test-'))
  rmSync(testDir, { recursive: true, force: true })
}
