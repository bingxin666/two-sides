/**
 * Job 状态机 + runner（docs/03 §6）
 *
 * 状态图：
 *   pending → generating → ready | failed
 *   failed  → pending   仅由 POST 触发且过冷却（ANALYSIS_RETRY_COOLDOWN_SEC）
 *   ready   → pending   仅 POST ?force=1
 *   failed 不自动重试（防额度黑洞）；次日 cron 用新日期键自然重建
 *
 * 并发归属（§6.3）：谁成功 INSERT jobs 谁才有权启动 runner。
 * UNIQUE(date, qid) 即锁 —— INSERT OR IGNORE 返回 changes===0 表示已有 worker 持有，
 * 本进程直接读它的进度返回，绝不启动第二个 runner。
 *
 * 恢复：启动时扫描当日 pending/generating 重入队；failed 不入队。
 */

import { randomUUID } from 'node:crypto'
import { ERROR_COPY, type ErrorCode, type ProgressResp, type Stage } from '@two-sides/contract'
import { env } from './env'
import { errFields, log } from './log'
import { runPipeline, createAgents } from './pipeline'
import {
  beginRun,
  deleteJob,
  getAnalysis,
  getJob,
  insertJobIgnore,
  listRecoverable,
  markFailed,
  markReady,
  purgeBefore,
  setAnalysisStatus,
  setJobStatus,
  updateJobProgress,
  type AnalysisRow,
  type JobRow,
  type ProgressPatch,
} from './repo'
import { parseIso, shiftDateKey, todayKey } from './time'
import { resolveQuestionTitle } from './zhihu/title'
import type { PipelineContext } from './agents/types'
import { PipelineError } from './agents/types'

/** 本进程标识：写入 jobs.owner，重启恢复与诊断用 */
export const PROCESS_ID = randomUUID().slice(0, 8)

/** 正在本进程跑的 job：key → abort 控制器（「只有一个 runner」的第二道保险） */
const running = new Map<string, AbortController>()

/** stale 判定宽限：job 总时限之外再给 30s，避免误抢还在跑的任务 */
export const STALE_GRACE_MS = 30_000

/** 进度落库节流：避免高频写 SQLite */
const PROGRESS_WRITE_MS = 400

export function jobKey(date: string, qid: string): string {
  return `${date}:${qid}`
}

export function isRunningHere(date: string, qid: string): boolean {
  return running.has(jobKey(date, qid))
}

/* ------------------------------ 竞争与启动 ------------------------------ */

export interface AcquireResult {
  owned: boolean
  job: JobRow | null
}

export interface AcquireOptions {
  /**
   * 是否允许接管 failed（仅 POST 重试路径，且调用方已确认过冷却）。
   * 默认 false —— failed 是终态，GET 路径永不接管（§6.1）。
   */
  allowFailedRetry?: boolean
}

/**
 * 参与 jobs 的 INSERT 竞争。
 * owned===true 表示本进程抢到了所有权，调用方必须启动 runner（且只能启动一次）。
 */
export function tryAcquire(date: string, qid: string, opts: AcquireOptions = {}): AcquireResult {
  const k = jobKey(date, qid)
  const analysis = getAnalysis(date, qid)

  // failed 是终态：GET 路径永远不接管，只能由 POST 显式重试（§6.1）
  if (analysis?.status === 'failed' && !opts.allowFailedRetry) {
    return { owned: false, job: getJob(date, qid) }
  }

  const existing = getJob(date, qid)
  if (existing) {
    const aliveHere = running.has(k)
    const age = Date.now() - parseIso(existing.updated_at)
    // age < 0 说明时间戳不可信（时钟回拨/脏数据），同样视为僵死，不能让它永久占着锁
    const stale =
      !Number.isFinite(age) || age < 0 || age > env.JOB_TIMEOUT_SEC * 1000 + STALE_GRACE_MS
    // 本进程没在跑 + （从未启动过 / 已僵死）→ 释放旧锁，重新参与同一套竞争
    if (!aliveHere && (existing.status === 'pending' || stale)) {
      log.warn('job.stale.takeover', { qid, date, jobId: existing.id, ageMs: Math.round(age) })
      deleteJob(date, qid)
    } else {
      return { owned: false, job: existing }
    }
  }

  const attempts = (analysis?.attempts ?? 0) + 1
  beginRun(date, qid, attempts)

  const id = randomUUID()
  const changes = insertJobIgnore({
    id,
    date,
    qid,
    stage: 'extract',
    attempts,
    owner: PROCESS_ID,
  })
  if (changes !== 1) {
    // UNIQUE 冲突：别的 worker 已经持有，读它的进度
    return { owned: false, job: getJob(date, qid) }
  }
  return { owned: true, job: getJob(date, qid) }
}

/** 启动 runner（fire-and-forget）。内部保证任何异常都被收敛成终态。 */
export function startRunner(date: string, qid: string, job: JobRow, titleHint?: string): void {
  void runJob(date, qid, job, titleHint)
}

/**
 * 等待完成的 runner（预生成批次用：小并发批间等待，跑完一个再放下一批）。
 * 与 startRunner 同一 runJob 路径：异常在内部收敛为终态 failed，永不 reject。
 */
export function startRunnerAwait(date: string, qid: string, job: JobRow, titleHint?: string): Promise<void> {
  return runJob(date, qid, job, titleHint)
}

async function runJob(date: string, qid: string, job: JobRow, titleHint?: string): Promise<void> {
  const k = jobKey(date, qid)
  const controller = new AbortController()
  running.set(k, controller)

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, env.JOB_TIMEOUT_SEC * 1000)

  const notes: Array<Record<string, unknown>> = []
  let progress: ProgressPatch = {
    stage: 'extract',
    stageRatio: 0,
    sampleCount: 0,
    judgmentsDone: 0,
    judgmentsTotal: 0,
  }
  let lastWrite = 0
  const flush = (force: boolean) => {
    const now = Date.now()
    if (!force && now - lastWrite < PROGRESS_WRITE_MS) return
    lastWrite = now
    try {
      updateJobProgress(job.id, date, qid, { ...progress, detail: notes.slice(-20) })
    } catch (e) {
      log.error('job.progress.writeFailed', { qid, ...errFields(e) })
    }
  }

  const ctx: PipelineContext = {
    qid,
    date,
    titleHint,
    signal: controller.signal,
    report(p) {
      progress = { ...progress, ...p }
      flush(false)
    },
    note(event, fields) {
      notes.push({ event, t: new Date().toISOString(), ...(fields ?? {}) })
    },
  }

  try {
    // 快失败闸门（2026-09-12 产品决策：产品输入只有「问题文字」，qid 不做任何反查）。
    // llm 模式下无 titleHint 且 question_titles 缓存未命中 → 不跑管线、不碰任何
    // 网络，直接终态 failed（fake 模式为开发确定性，不走此闸门）。
    if (env.PIPELINE_MODE === 'llm' && !resolveQuestionTitle(qid, titleHint)) {
      log.info('job.title.miss', { qid, date, jobId: job.id })
      fail(job, job.attempts, {
        code: 'zhihu_error',
        message: ERROR_COPY.zhihu_error.message,
        stage: 'extract',
        retryable: true,
        detail: [{ event: 'title.miss', t: new Date().toISOString() }],
      })
      return
    }

    setAnalysisStatus(date, qid, 'generating', job.attempts)
    setJobStatus(job.id, date, qid, 'generating')
    log.info('job.start', { qid, date, jobId: job.id, attempts: job.attempts, mode: env.PIPELINE_MODE })

    const analysis = await runPipeline(createAgents(env.PIPELINE_MODE), ctx)
    if (controller.signal.aborted) {
      fail(job, job.attempts, {
        code: 'timeout',
        message: ERROR_COPY.timeout.message,
        stage: progress.stage,
        retryable: true,
        detail: notes.slice(-20),
      })
      return
    }
    markReady(
      job.id,
      date,
      qid,
      JSON.stringify(analysis),
      { ...progress, stage: 'render', stageRatio: 1, detail: notes.slice(-20) },
    )
    log.info('job.ready', { qid, date, judgments: analysis.judgments.length })
  } catch (e) {
    const mapped = classify(e, timedOut || controller.signal.aborted, progress.stage)
    fail(job, job.attempts, { ...mapped, detail: [...notes.slice(-20), { event: 'error', ...errFields(e) }] })
  } finally {
    clearTimeout(timer)
    running.delete(k)
  }
}

function fail(job: JobRow, attempts: number, f: Parameters<typeof markFailed>[4]): void {
  try {
    markFailed(job.id, job.date, job.qid, attempts, f)
    log.warn('job.failed', {
      qid: job.qid,
      date: job.date,
      code: f.code,
      stage: f.stage,
      retryable: f.retryable,
    })
  } catch (e) {
    // 连失败状态都写不进去是严重故障，至少留下日志，别静默
    log.error('job.failed.writeFailed', { qid: job.qid, ...errFields(e) })
  }
}

/** 异常 → ErrorCode + 可重试性（docs/03 §6.2） */
function classify(
  e: unknown,
  aborted: boolean,
  stage: Stage,
): { code: ErrorCode; message: string; stage: Stage; retryable: boolean } {
  if (aborted) {
    return { code: 'timeout', message: ERROR_COPY.timeout.message, stage, retryable: true }
  }
  if (e instanceof PipelineError) {
    return {
      code: e.mapped,
      message: ERROR_COPY[e.mapped].message,
      stage: e.stage,
      // 服务端判定优先：quota_exhausted / 鉴权失败不可重试
      retryable: e.mapped === 'quota_exhausted' ? false : e.retryable,
    }
  }
  if (e instanceof Error && e.name === 'AbortError') {
    return { code: 'timeout', message: ERROR_COPY.timeout.message, stage, retryable: true }
  }
  log.error('job.unexpectedError', errFields(e))
  return { code: 'llm_error', message: ERROR_COPY.llm_error.message, stage, retryable: true }
}

/* -------------------------------- 读取 -------------------------------- */

/** 冷却窗口内不允许重复 POST 触发（§6.3） */
export function inCooldown(row: AnalysisRow): boolean {
  const t = parseIso(row.updated_at)
  if (!Number.isFinite(t)) return false
  return Date.now() - t < env.RETRY_COOLDOWN_SEC * 1000
}

/**
 * 读进度。ready 返回 null（调用方改返回 200 + 快照）；无记录也返回 null。
 */
export function readProgress(date: string, qid: string): ProgressResp | null {
  const a = getAnalysis(date, qid)
  if (!a) return null
  if (a.status === 'ready') return null

  const j = getJob(date, qid)
  const base = {
    stage: (j?.stage ?? 'extract') as Stage,
    stageRatio: clamp01(j?.stage_ratio ?? 0),
    sampleCount: j?.sample_count ?? 0,
    judgmentsDone: j?.judgments_done ?? 0,
    judgmentsTotal: j?.judgments_total ?? 0,
  }

  if (a.status === 'failed') {
    const code: ErrorCode = a.error_code ?? 'llm_error'
    const retryable = j?.retryable === null || j?.retryable === undefined
      ? ERROR_COPY[code].retryable
      : j.retryable === 1
    return {
      ...base,
      status: 'failed',
      error: {
        code,
        message: a.error_message ?? ERROR_COPY[code].message,
        retryable,
      },
    }
  }

  return { ...base, status: a.status === 'generating' ? 'generating' : 'pending' }
}

/**
 * 显式重跑（POST 重试 / ?force=1）：先删旧 job 行释放锁，再参与同一套竞争（§6.3）。
 * 冷却检查由调用方在之前完成。
 */
export function restart(date: string, qid: string): AcquireResult {
  deleteJob(date, qid)
  return tryAcquire(date, qid, { allowFailedRetry: true })
}

/** 主动取消（供内部/运维使用）：只 abort 本进程内的 runner，不改状态语义 */
export function abort(date: string, qid: string): boolean {
  const c = running.get(jobKey(date, qid))
  if (!c) return false
  c.abort()
  return true
}

/* ------------------------------ 启动恢复 ------------------------------ */

/** 启动时重入队当日未完成的 job，并清理 7 天前数据 */
export function recoverOnBoot(): void {
  const date = todayKey()
  try {
    purgeBefore(shiftDateKey(date, -7))
  } catch (e) {
    log.warn('boot.purgeFailed', errFields(e))
  }

  if (!env.RECOVER_ON_BOOT) return
  const rows = listRecoverable(date)
  if (rows.length === 0) return
  log.info('boot.recover', { count: rows.length, date })
  for (const row of rows) {
    const res = tryAcquire(row.date, row.qid)
    if (res.owned && res.job) startRunner(row.date, row.qid, res.job)
  }
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}
