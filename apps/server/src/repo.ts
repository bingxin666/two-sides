/**
 * 数据访问层 —— analyses / jobs / hot_questions
 *
 * 约定：
 *  - `analyses.status` 是权威状态（主端点与 /hot 都先读它）
 *  - `jobs` 存阶段进度与所有权；它的 UNIQUE(date,qid) 是并发锁
 *  - 任何「状态 + 进度」的成对写入都走同一个事务，避免两份状态漂移
 */

import { getDb } from './db'
import type { JobStatus, Stage, ErrorCode } from '@two-sides/contract'
import { nowIso } from './time'

export interface AnalysisRow {
  date: string
  qid: string
  status: JobStatus
  data: string | null
  error_code: ErrorCode | null
  error_message: string | null
  attempts: number
  updated_at: string
}

export interface JobRow {
  id: string
  date: string
  qid: string
  status: JobStatus
  stage: Stage
  stage_ratio: number
  sample_count: number
  judgments_done: number
  judgments_total: number
  error_code: ErrorCode | null
  error_message: string | null
  retryable: number | null
  attempts: number
  detail: string | null
  owner: string
  started_at: string
  updated_at: string
}

export interface HotQuestionRow {
  date: string
  qid: string
  title: string
  url: string
  fetched_at: string
}

type Sql = ReturnType<typeof getDb>

let _s: ReturnType<typeof buildStmts> | null = null

function buildStmts(db: Sql) {
  return {
    getAnalysis: db.query<AnalysisRow | null, [string, string]>(
      `SELECT date, qid, status, data, error_code, error_message, attempts, updated_at
         FROM analyses WHERE date = ? AND qid = ?`,
    ),
    getJob: db.query<JobRow | null, [string, string]>(
      `SELECT * FROM jobs WHERE date = ? AND qid = ?`,
    ),
    insertAnalysisIgnore: db.query<void, [string, string, string, number, string]>(
      `INSERT OR IGNORE INTO analyses (date, qid, status, data, error_code, error_message, attempts, updated_at)
       VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?)`,
    ),
    /** 仅改状态（不清快照），用于 pending → generating */
    upsertAnalysisStatus: db.query<void, [string, string, JobStatus, number, string]>(
      `INSERT INTO analyses (date, qid, status, attempts, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (date, qid) DO UPDATE SET
         status = excluded.status,
         attempts = excluded.attempts,
         updated_at = excluded.updated_at`,
    ),
    /**
     * 开跑：状态置 pending 并清空上一轮的快照与错误。
     * attempts 由调用方累加后传入，updated_at 刷新（冷却窗口以它为准）。
     */
    beginRun: db.query<void, [string, string, JobStatus, number, string]>(
      `INSERT INTO analyses (date, qid, status, attempts, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (date, qid) DO UPDATE SET
         status = excluded.status,
         attempts = excluded.attempts,
         updated_at = excluded.updated_at,
         data = NULL,
         error_code = NULL,
         error_message = NULL`,
    ),
    setAnalysisStatus: db.query<void, [JobStatus, string, string, string]>(
      `UPDATE analyses SET status = ?, updated_at = ? WHERE date = ? AND qid = ?`,
    ),
    setAnalysisError: db.query<
      void,
      [JobStatus, ErrorCode, string, number, string, string, string]
    >(
      `UPDATE analyses SET status = ?, error_code = ?, error_message = ?,
              attempts = ?, updated_at = ?, data = NULL
         WHERE date = ? AND qid = ?`,
    ),
    setAnalysisReady: db.query<void, [string, string, string, string]>(
      `UPDATE analyses SET status = 'ready', data = ?, error_code = NULL,
              error_message = NULL, updated_at = ?
         WHERE date = ? AND qid = ?`,
    ),
    insertJobIgnore: db.query<
      void,
      [string, string, string, JobStatus, string, number, string, string, string]
    >(
      `INSERT OR IGNORE INTO jobs
         (id, date, qid, status, stage, stage_ratio, sample_count, judgments_done,
          judgments_total, attempts, owner, started_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, ?, ?, ?, ?)`,
    ),
    updateJobStatus: db.query<void, [JobStatus, string, string, string, string]>(
      `UPDATE jobs SET status = ?, updated_at = ? WHERE id = ? AND date = ? AND qid = ?`,
    ),
    updateJobProgress: db.query<
      void,
      [
        Stage,
        number,
        number,
        number,
        number,
        number | null,
        string | null,
        string,
        string,
        string,
        string,
      ]
    >(
      `UPDATE jobs SET stage = ?, stage_ratio = ?, sample_count = ?,
              judgments_done = ?, judgments_total = ?, retryable = ?,
              error_code = NULL, error_message = NULL,
              detail = ?, updated_at = ?
         WHERE id = ? AND date = ? AND qid = ?`,
    ),
    updateJobError: db.query<
      void,
      [Stage, ErrorCode, string, number, string | null, string, string, string, string]
    >(
      `UPDATE jobs SET stage = ?, error_code = ?, error_message = ?, retryable = ?,
              detail = ?, status = 'failed', updated_at = ?
         WHERE id = ? AND date = ? AND qid = ?`,
    ),
    deleteJob: db.query<void, [string, string]>(`DELETE FROM jobs WHERE date = ? AND qid = ?`),
    listRecoverable: db.query<JobRow, [string]>(
      `SELECT * FROM jobs WHERE date = ? AND status IN ('pending','generating') ORDER BY started_at`,
    ),
    upsertHot: db.query<void, [string, string, string, string, string]>(
      `INSERT INTO hot_questions (date, qid, title, url, fetched_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (date, qid) DO UPDATE SET
         title = excluded.title, url = excluded.url, fetched_at = excluded.fetched_at`,
    ),
    listReadyHot: db.query<{ qid: string; title: string }, [string]>(
      `SELECT h.qid AS qid, h.title AS title
         FROM hot_questions h
         JOIN analyses a ON a.date = h.date AND a.qid = h.qid
        WHERE h.date = ? AND a.status = 'ready'
        ORDER BY h.rowid`,
    ),
    purgeAnalyses: db.query<void, [string]>(`DELETE FROM analyses WHERE date < ?`),
    purgeJobs: db.query<void, [string]>(`DELETE FROM jobs WHERE date < ?`),
    purgeHot: db.query<void, [string]>(`DELETE FROM hot_questions WHERE date < ?`),
  }
}

function s() {
  if (!_s) _s = buildStmts(getDb())
  return _s
}

/* ------------------------------ analyses ------------------------------ */

export function getAnalysis(date: string, qid: string): AnalysisRow | null {
  return s().getAnalysis.get(date, qid) ?? null
}

export function getJob(date: string, qid: string): JobRow | null {
  return s().getJob.get(date, qid) ?? null
}

/** 占位行：让「已接单但还没起 runner」的状态可查，同时刷新 updated_at（冷却基准） */
export function ensureAnalysisRow(date: string, qid: string, status: JobStatus, attempts = 1): void {
  s().insertAnalysisIgnore.run(date, qid, status, attempts, nowIso())
}

export function setAnalysisStatus(
  date: string,
  qid: string,
  status: JobStatus,
  attempts: number,
): void {
  s().upsertAnalysisStatus.run(date, qid, status, attempts, nowIso())
}

/** 开跑：pending + 清快照 + 累加 attempts + 刷新 updated_at */
export function beginRun(date: string, qid: string, attempts: number): void {
  s().beginRun.run(date, qid, 'pending', attempts, nowIso())
}

/* --------------------------------- jobs -------------------------------- */

export interface InsertJobInput {
  id: string
  date: string
  qid: string
  stage: Stage
  attempts: number
  owner: string
}

/**
 * 并发锁的核心：INSERT OR IGNORE。
 * 返回 changes===1 表示本进程抢到了所有权（有权启动 runner）；
 * changes===0 表示 UNIQUE(date,qid) 冲突，已有 worker 持有，绝不启动第二个 runner。
 */
export function insertJobIgnore(input: InsertJobInput): number {
  const now = nowIso()
  const res = s().insertJobIgnore.run(
    input.id,
    input.date,
    input.qid,
    'pending',
    input.stage,
    input.attempts,
    input.owner,
    now,
    now,
  )
  return res.changes
}

export function deleteJob(date: string, qid: string): number {
  return s().deleteJob.run(date, qid).changes
}

export interface ProgressPatch {
  stage: Stage
  stageRatio: number
  sampleCount: number
  judgmentsDone: number
  judgmentsTotal: number
  detail?: unknown
}

export function updateJobProgress(jobId: string, date: string, qid: string, p: ProgressPatch): void {
  s().updateJobProgress.run(
    p.stage,
    clamp01(p.stageRatio),
    p.sampleCount,
    p.judgmentsDone,
    p.judgmentsTotal,
    null,
    p.detail === undefined ? null : JSON.stringify(p.detail),
    nowIso(),
    jobId,
    date,
    qid,
  )
}

export function setJobStatus(jobId: string, date: string, qid: string, status: JobStatus): void {
  s().updateJobStatus.run(status, nowIso(), jobId, date, qid)
}

/** 单事务内完成「写快照 + 状态置 ready」，两者要么都成要么都不成 */
export function markReady(
  jobId: string,
  date: string,
  qid: string,
  analysisJson: string,
  p: ProgressPatch,
): void {
  const db = getDb()
  const tx = db.transaction(() => {
    s().setAnalysisReady.run(analysisJson, nowIso(), date, qid)
    s().updateJobProgress.run(
      p.stage,
      clamp01(p.stageRatio),
      p.sampleCount,
      p.judgmentsDone,
      p.judgmentsTotal,
      null,
      p.detail === undefined ? null : JSON.stringify(p.detail),
      nowIso(),
      jobId,
      date,
      qid,
    )
    s().updateJobStatus.run('ready', nowIso(), jobId, date, qid)
  })
  tx()
}

export interface FailInput {
  code: ErrorCode
  message: string
  stage: Stage
  retryable: boolean
  detail?: unknown
}

/** 单事务内完成「状态置 failed + 记录失败阶段与可重试性」 */
export function markFailed(
  jobId: string,
  date: string,
  qid: string,
  attempts: number,
  f: FailInput,
): void {
  const db = getDb()
  const detail = f.detail === undefined ? null : JSON.stringify(f.detail)
  const tx = db.transaction(() => {
    s().setAnalysisError.run(
      'failed',
      f.code,
      f.message.slice(0, 500),
      attempts,
      nowIso(),
      date,
      qid,
    )
    s().updateJobError.run(
      f.stage,
      f.code,
      f.message.slice(0, 500),
      f.retryable ? 1 : 0,
      detail,
      nowIso(),
      jobId,
      date,
      qid,
    )
  })
  tx()
}

export function listRecoverable(date: string): JobRow[] {
  return s().listRecoverable.all(date)
}

/* ---------------------------- hot_questions ---------------------------- */

export function upsertHotQuestions(date: string, items: HotQuestionRow[]): void {
  const db = getDb()
  const tx = db.transaction(() => {
    for (const it of items) {
      s().upsertHot.run(it.date, it.qid, it.title, it.url, it.fetched_at)
    }
  })
  tx()
}

/** 只返回当日已 ready 的题（docs/03 §5.3） */
export function listReadyHot(date: string): Array<{ qid: string; title: string }> {
  return s().listReadyHot.all(date)
}

/** 清理 7 天前数据（docs/03 §7） */
export function purgeBefore(cutoffDateKey: string): void {
  const db = getDb()
  const tx = db.transaction(() => {
    s().purgeAnalyses.run(cutoffDateKey)
    s().purgeJobs.run(cutoffDateKey)
    s().purgeHot.run(cutoffDateKey)
  })
  tx()
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}
