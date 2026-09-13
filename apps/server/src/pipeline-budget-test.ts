/** Deterministic budget regressions: virtual clock, fake agents, isolated SQLite, no network. */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'
import type { PipelineAgents, PipelineContext, PipelineProgress } from './agents/types'

const originalCwd = process.cwd()
const originalFetch = globalThis.fetch
const originalNow = Date.now
const originalSetTimeout = globalThis.setTimeout
const originalClearTimeout = globalThis.clearTimeout
const tempRoot = resolve(tmpdir())
const testDir = mkdtempSync(resolve(tempRoot, 'two-sides-budget-test-'))
process.chdir(testDir)
writeFileSync(resolve(testDir, '.env'), '')
Object.assign(process.env, {
  ZHIHU_LIVE: '0',
  ZHIHU_ACCESS_SECRET: 'test-only-not-a-real-secret',
  ZHIDUAN_DB_PATH: resolve(testDir, 'job-test.db'),
  PIPELINE_MODE: 'fake',
  PIPELINE_FAKE_DURATION_MS: '5',
  ANALYSIS_JOB_TIMEOUT_SEC: '180',
  PIPELINE_EXTRACT_CONCURRENCY: '1',
  PIPELINE_ORIENT_CONCURRENCY: '1',
  RECOVER_ON_BOOT: 'false',
  LOG_LEVEL: 'error',
})
let networkRequests = 0
globalThis.fetch = (async () => {
  networkRequests++
  throw new Error('Network access is forbidden in pipeline budget tests')
}) as unknown as typeof fetch

const initialTime = Date.parse('2026-09-13T04:00:00Z')
let now = initialTime
let nextTimer = 1
let closeDatabase: (() => void) | undefined
interface VirtualTimer { at: number; delay: number; fire: () => void }
const timers = new Map<number, VirtualTimer>()
Date.now = () => now
globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay = 0, ...args: unknown[]) => {
  const id = nextTimer++
  timers.set(id, { at: now + Math.max(0, delay), delay, fire: () => callback(...args) })
  return id as unknown as ReturnType<typeof setTimeout>
}) as typeof setTimeout
globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
  timers.delete(handle as unknown as number)
}) as typeof clearTimeout

const sleep = (ms: number) => new Promise<void>((resolvePromise) => setTimeout(resolvePromise, ms))
const never = <T>(): Promise<T> => new Promise(() => {})

/** Drain asynchronous pipeline work, then advance directly to the next timer. */
async function drive<T>(promise: Promise<T>, skipTimer: (timer: VirtualTimer) => boolean = () => false): Promise<T> {
  let settled = false
  let value!: T
  let error: unknown
  let failed = false
  void promise.then((result) => { value = result; settled = true }, (e) => { error = e; failed = true; settled = true })
  for (let turn = 0; turn < 100; turn++) {
    for (let tick = 0; tick < 300; tick++) await Promise.resolve()
    if (settled) {
      if (failed) throw error
      return value
    }
    const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
    assert.ok(next, 'Pipeline stalled without a deadline timer')
    timers.delete(next[0])
    if (skipTimer(next[1])) continue
    now = next[1].at
    next[1].fire()
  }
  assert.fail('Pipeline failed to settle within the bounded virtual schedule')
}

async function main(): Promise<void> {
  const { runPipeline, summaryDegradation } = await import('./pipeline')
  const { createFakeAgents } = await import('./agents/fake')
  const { PipelineError } = await import('./agents/types')
  const { runWithBudget, PHASE_BUDGETS } = await import('./budget')
  const { Analysis, checkCountingRules } = await import('@two-sides/contract')
  let passed = 0

  function context(durationMs = 180_000) {
    const controller = new AbortController()
    const notes: Array<{ event: string; fields?: Record<string, unknown> }> = []
    const progress: Array<Partial<PipelineProgress>> = []
    const ctx: PipelineContext = {
      qid: '91001', date: '2026-09-13', signal: controller.signal,
      deadlineAt: now + durationMs,
      note: (event, fields) => notes.push({ event, fields }),
      report: (p) => progress.push(p),
    }
    return { ctx, controller, notes, progress }
  }

  function valid(result: unknown): void {
    const analysis = Analysis.parse(result)
    assert.deepEqual(checkCountingRules(analysis), [])
    assert.ok(analysis.judgments.length > 0)
  }

  async function check(name: string, run: () => Promise<void>): Promise<void> {
    timers.clear()
    now = initialTime
    await run()
    assert.equal(networkRequests, 0)
    assert.equal(timers.size, 0, 'Completed phase left an active deadline timer')
    console.log(`ok ${++passed} - ${name}`)
  }

  await check('normal fake pipeline keeps valid judgments and summary', async () => {
    const { ctx, controller } = context()
    const result = await drive(runPipeline(createFakeAgents({ stepMs: 0 }), ctx))
    valid(result)
    assert.ok(result.judgments.every((j) => j.summary))
    assert.equal(controller.signal.aborted, false)
    assert.equal(now, initialTime)
  })

  await check('summary ignoring cancellation is bounded and preserves a ready result', async () => {
    const { ctx, controller, notes } = context()
    const before = summaryDegradation.count
    let scopedSummary: PipelineContext | undefined
    const agents: PipelineAgents = {
      ...createFakeAgents({ stepMs: 0 }),
      summarize: async (_answers, _judgments, scoped) => {
        scopedSummary = scoped
        return never()
      },
    }
    const result = await drive(runPipeline(agents, ctx))
    valid(result)
    assert.equal(now - initialTime, PHASE_BUDGETS.summary.capMs)
    assert.equal(scopedSummary?.signal.aborted, true)
    assert.equal(controller.signal.aborted, false)
    assert.equal(summaryDegradation.count, before + 1)
    assert.ok(notes.some((n) => n.event === 'summary.degraded'))
    assert.ok(result.judgments.every((j) => j.summary === undefined && j.summarySource === undefined))
  })

  await check('an already cancelled job never starts agents or produces a result', async () => {
    const { ctx, controller, progress } = context()
    controller.abort()
    let called = false
    const agents: PipelineAgents = {
      ...createFakeAgents({ stepMs: 0 }),
      fetchAnswers: async () => { called = true; return never() },
    }
    await assert.rejects(drive(runPipeline(agents, ctx)), (e: unknown) => e instanceof PipelineError && e.mapped === 'timeout')
    assert.equal(called, false)
    assert.equal(progress.some((p) => p.stage === 'render' && p.stageRatio === 1), false)
  })

  await check('whole-job cancellation during optional summary cannot become ready', async () => {
    const { ctx, controller, progress } = context()
    const agents: PipelineAgents = {
      ...createFakeAgents({ stepMs: 0 }),
      summarize: async () => {
        controller.abort()
        return never()
      },
    }
    await assert.rejects(drive(runPipeline(agents, ctx)), (e: unknown) => e instanceof PipelineError && e.mapped === 'timeout')
    assert.equal(controller.signal.aborted, true)
    assert.equal(progress.some((p) => p.stage === 'render' && p.stageRatio === 1), false)
  })

  await check('merge cannot consume the deadline reserved for downstream stages', async () => {
    const { ctx, controller } = context(1000)
    const reserveScale = 0.01
    let phase: PipelineContext | undefined
    await assert.rejects(drive(runWithBudget(ctx, 'merge', reserveScale, async (scoped) => {
      phase = scoped
      return never()
    })), (e: unknown) => e instanceof PipelineError && e.mapped === 'timeout' && e.stage === 'merge')
    assert.equal(now, initialTime + 1000 - PHASE_BUDGETS.merge.reserveMs * reserveScale)
    assert.equal(phase?.deadlineAt, now)
    assert.equal(phase?.signal.aborted, true)
    assert.equal(controller.signal.aborted, false)
    assert.equal(ctx.deadlineAt! - now, PHASE_BUDGETS.merge.reserveMs * reserveScale)
  })

  await check('queued extract and orient calls share phase deadlines instead of refreshing them', async () => {
    const { ctx } = context()
    const base = createFakeAgents({ stepMs: 0 })
    const extractCalls: Array<{ start: number; deadline: number }> = []
    const orientCalls: Array<{ start: number; deadline: number }> = []
    const agents: PipelineAgents = {
      ...base,
      extract: async (batch, scoped) => {
        extractCalls.push({ start: now, deadline: scoped.deadlineAt! })
        await sleep(1000)
        return base.extract(batch, scoped)
      },
      orient: async (judgment, answers, scoped) => {
        orientCalls.push({ start: now, deadline: scoped.deadlineAt! })
        await sleep(1000)
        return base.orient(judgment, answers, scoped)
      },
    }
    valid(await drive(runPipeline(agents, ctx)))
    for (const calls of [extractCalls, orientCalls]) {
      assert.ok(calls.length >= 3)
      assert.equal(new Set(calls.map((c) => c.deadline)).size, 1)
      assert.equal(calls[1]!.start - calls[0]!.start, 1000)
      assert.ok(calls.at(-1)!.deadline - calls.at(-1)!.start < calls[0]!.deadline - calls[0]!.start)
    }
  })

  await check('extract phase timeout retains completed batches for downstream processing', async () => {
    const { ctx, controller, notes } = context()
    const base = createFakeAgents({ stepMs: 0 })
    let calls = 0
    const agents: PipelineAgents = {
      ...base,
      extract: async (batch, scoped) => {
        if (++calls === 1) return base.extract(batch, scoped)
        return never()
      },
    }
    valid(await drive(runPipeline(agents, ctx)))
    assert.equal(calls, 2, 'Queued batches must not start once the phase has expired')
    assert.equal(controller.signal.aborted, false)
    assert.equal(now - initialTime, PHASE_BUDGETS.extract.capMs)
    assert.ok(notes.some((n) => n.event === 'extract.partialTimeout' && n.fields?.completed === 1))
  })

  await check('empty extraction plus a hanging batch preserves the original timeout failure', async () => {
    const { ctx, controller, notes } = context()
    const base = createFakeAgents({ stepMs: 0 })
    let calls = 0
    let merged = false
    const agents: PipelineAgents = {
      ...base,
      extract: async () => ++calls === 1 ? [] : never(),
      merge: async (items, scoped) => { merged = true; return base.merge(items, scoped) },
    }
    await assert.rejects(drive(runPipeline(agents, ctx)), (e: unknown) => e instanceof PipelineError && e.mapped === 'timeout' && e.stage === 'extract')
    assert.equal(calls, 2)
    assert.equal(merged, false)
    assert.equal(controller.signal.aborted, false)
    assert.equal(notes.some((n) => n.event === 'extract.partialTimeout'), false)
    assert.equal(now - initialTime, PHASE_BUDGETS.extract.capMs)
  })

  await check('orient phase timeout retains completed judgments and discards late results', async () => {
    const { ctx, controller, notes, progress } = context()
    const base = createFakeAgents({ stepMs: 0 })
    let calls = 0
    let releaseLate!: () => void
    let lateContext: PipelineContext | undefined
    const agents: PipelineAgents = {
      ...base,
      orient: async (judgment, answers, scoped) => {
        if (++calls <= 2) return base.orient(judgment, answers, scoped)
        lateContext = scoped
        await new Promise<void>((resolvePromise) => { releaseLate = resolvePromise })
        scoped.report({ stage: 'orient', stageRatio: 0.1 })
        scoped.note('test.late.result')
        return base.orient(judgment, answers, scoped)
      },
    }
    const result = await drive(runPipeline(agents, ctx))
    valid(result)
    assert.equal(result.judgments.length, 2)
    assert.equal(calls, 3)
    assert.equal(controller.signal.aborted, false)
    assert.equal(lateContext?.signal.aborted, true)
    assert.equal(now - initialTime, PHASE_BUDGETS.orient.capMs)
    assert.ok(notes.some((n) => n.event === 'orient.partialTimeout' && n.fields?.completed === 2))
    const notesBefore = notes.length
    const progressBefore = progress.length
    releaseLate()
    for (let tick = 0; tick < 300; tick++) await Promise.resolve()
    assert.equal(calls, 3, 'Expired queued judgments must never call the agent')
    assert.equal(result.judgments.length, 2)
    assert.equal(notes.length, notesBefore)
    assert.equal(progress.length, progressBefore)
  })

  await check('job runner persists ready when its optional summary reaches the phase timeout', async () => {
    const { getDb, closeDb } = await import('./db')
    const { getJob, getAnalysis } = await import('./repo')
    const { tryAcquire, startRunnerAwait, isRunningHere } = await import('./jobs')
    closeDatabase = closeDb
    getDb()
    const date = '2026-09-13'
    const qid = '92001'
    const acquired = tryAcquire(date, qid)
    assert.equal(acquired.owned, true)
    assert.ok(acquired.job)
    let blockedSummaryStep = false
    let summaryBudgetActive = false
    const previousSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay = 0, ...args: unknown[]) => {
      if (delay === PHASE_BUDGETS.summary.capMs) summaryBudgetActive = true
      return previousSetTimeout(callback, delay, ...args)
    }) as typeof setTimeout
    // The real fake agent uses 1ms steps. Withhold its summary step so the
    // actual runJob -> runPipeline -> summary budget path performs the abort.
    try {
      await drive(startRunnerAwait(date, qid, acquired.job), (timer) => {
        if (!blockedSummaryStep && timer.delay === 1 && summaryBudgetActive) {
          blockedSummaryStep = true
          return true
        }
        return false
      })
    } finally {
      globalThis.setTimeout = previousSetTimeout
    }
    assert.equal(blockedSummaryStep, true)
    assert.equal(getAnalysis(date, qid)?.status, 'ready')
    assert.equal(getJob(date, qid)?.status, 'ready')
    assert.equal(getAnalysis(date, qid)?.error_code, null)
    assert.equal(isRunningHere(date, qid), false)
    const data = JSON.parse(getAnalysis(date, qid)!.data!)
    valid(data)
    assert.ok(data.judgments.every((j: { summary?: string }) => j.summary === undefined))
    assert.ok(now - initialTime < 180_000)
  })

  console.log(`pipeline budget tests passed (${passed} cases; virtual time; zero network requests)`)
}

try {
  await main()
} finally {
  closeDatabase?.()
  timers.clear()
  globalThis.fetch = originalFetch
  Date.now = originalNow
  globalThis.setTimeout = originalSetTimeout
  globalThis.clearTimeout = originalClearTimeout
  process.chdir(originalCwd)
  assert.equal(dirname(testDir), tempRoot)
  assert.ok(basename(testDir).startsWith('two-sides-budget-test-'))
  rmSync(testDir, { recursive: true, force: true })
}
