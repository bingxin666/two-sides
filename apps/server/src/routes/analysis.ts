/**
 * 主端点（docs/03 §5.3）
 *
 * GET  /api/v1/questions/:qid/analysis
 *      ready → 200 + Analysis；未完成/失败 → 202 + ProgressResp；
 *      qid 非法 → 404。快照未命中时参与 jobs 的 INSERT 竞争，
 *      抢到所有权才启动 runner（全系统唯一一处读请求带副作用，§5.3）。
 *
 * POST /api/v1/questions/:qid/analysis
 *      仅失败重试 / ?force=1 强刷。幂等：pending/generating/ready 直接返回当前态；
 *      failed 需过冷却（ANALYSIS_RETRY_COOLDOWN_SEC）才重建 job。
 */

import { Hono } from 'hono'
import { Analysis as AnalysisSchema, ProgressResp as ProgressRespSchema } from '@two-sides/contract'
import { failResp, okData } from '../http'
import { inCooldown, readProgress, restart, startRunner, tryAcquire } from '../jobs'
import { log } from '../log'
import { getAnalysis } from '../repo'
import { todayKey } from '../time'

export const analysisRoutes = new Hono()

/** qid 必须是纯数字（知乎问题 id）。非数字直接 404，不进入任何竞争。 */
const QID_RE = /^\d{1,20}$/

function validQid(qid: string): boolean {
  return QID_RE.test(qid)
}

/** 取出 ready 快照；解析失败视为未命中（会触发重跑） */
function readyAnalysis(qid: string, date: string) {
  const row = getAnalysis(date, qid)
  if (!row || row.status !== 'ready' || !row.data) return null
  try {
    const parsed = AnalysisSchema.safeParse(JSON.parse(row.data))
    if (!parsed.success) {
      log.error('analysis.snapshotInvalid', {
        qid,
        date,
        issue: parsed.error.issues[0]?.message ?? 'unknown',
      })
      return null
    }
    return parsed.data
  } catch (e) {
    log.error('analysis.snapshotUnparsable', { qid, date, reason: String(e).slice(0, 160) })
    return null
  }
}

function progressOrFallback(date: string, qid: string) {
  const p = readProgress(date, qid)
  if (p) return ProgressRespSchema.parse(p)
  // 理论上到不了这里：tryAcquire 之后一定有 analyses 行。兜底给 pending 不报错。
  return ProgressRespSchema.parse({
    status: 'pending',
    stage: 'extract',
    stageRatio: 0,
    sampleCount: 0,
    judgmentsDone: 0,
    judgmentsTotal: 0,
  })
}

/* --------------------------------- GET --------------------------------- */

analysisRoutes.get('/questions/:qid/analysis', (c) => {
  const qid = c.req.param('qid')
  if (!validQid(qid)) return failResp(c, 404, '问题不存在或不是知乎问题')

  const date = todayKey()
  const row = getAnalysis(date, qid)

  // 1) 命中当日快照 → 纯读，零生成调用
  if (row?.status === 'ready') {
    const hit = readyAnalysis(qid, date)
    if (hit) return okData(c, 200, hit)
    // ready 但快照缺失/损坏：重跑一次（重跑后状态变 pending，不会反复触发）
    log.warn('analysis.readyButNoSnapshot', { qid, date })
    const fixed = restart(date, qid)
    if (fixed.owned && fixed.job) startRunner(date, qid, fixed.job)
    return okData(c, 202, progressOrFallback(date, qid))
  }

  // 2) 参与 INSERT 竞争；owned 才有资格启动 runner
  const acq = tryAcquire(date, qid)
  if (acq.owned && acq.job) {
    startRunner(date, qid, acq.job)
  } else {
    log.debug('analysis.get.attach', { qid, date, jobId: acq.job?.id ?? null })
  }

  // 3) 一律返回 202 + 进度（failed 也走这里，前端据此停止轮询）
  return okData(c, 202, progressOrFallback(date, qid))
})

/* -------------------------------- POST -------------------------------- */

analysisRoutes.post('/questions/:qid/analysis', (c) => {
  const qid = c.req.param('qid')
  if (!validQid(qid)) return failResp(c, 404, '问题不存在或不是知乎问题')

  const date = todayKey()
  const force = c.req.query('force') === '1'
  const row = getAnalysis(date, qid)

  // 幂等：非 failed 且非强刷 → 直接返回当前态，不建新 job
  if (row && row.status !== 'failed') {
    if (!force) {
      const hit = readyAnalysis(qid, date)
      if (hit) return okData(c, 200, hit)
      return okData(c, 202, progressOrFallback(date, qid))
    }
    // force=1：删旧 job 行后重跑（覆盖旧快照）
    const acq = restart(date, qid)
    if (acq.owned && acq.job) startRunner(date, qid, acq.job)
    return okData(c, 202, progressOrFallback(date, qid))
  }

  // failed：需过冷却，冷却内直接返回当前态（§6.3）
  if (row?.status === 'failed' && inCooldown(row)) {
    log.info('analysis.retry.cooldown', { qid, date, attempts: row.attempts })
    return okData(c, 202, progressOrFallback(date, qid))
  }

  // failed 已过冷却 或 完全无记录 → 参与竞争重跑
  const acq = row?.status === 'failed' ? restart(date, qid) : tryAcquire(date, qid)
  if (acq.owned && acq.job) {
    log.info('analysis.retry.start', { qid, date, attempts: acq.job.attempts, force })
    startRunner(date, qid, acq.job)
  }
  return okData(c, 202, progressOrFallback(date, qid))
})
