/**
 * 热榜预生成（D2-1，docs/04）
 *
 * 目标：让 GET /hot 在当天第一次被访问前就有真实数据 —— 00:30（Asia/Shanghai）
 * 拉热榜前 N 题逐题跑管线，用户白天点开热榜卡即 ready，不用现场等 1–2 分钟。
 *
 * 入口：
 *   1. pregenerate(topN)          —— 批次函数（本模块），cron 与手动脚本共用
 *   2. pregenerate:run --top N    —— 手动脚本（src/pregenerate-run.ts，双闸：--live 才真跑）
 *   3. startPregenerateCron()     —— 进程内 Bun timer 对齐每日 00:30，触发后 re-arm 次日
 *   4. pregenerateOnBoot()        —— 后台补齐当日热榜，优先复用 SQLite 中的候选
 *
 * 纪律（docs/01 §4.1 / team-lead 拍板）：
 *   - 全程走 ZHIHU_LIVE 闸：hotList 自带闸，闸关时 cron tick 只记日志不硬跑
 *   - 每批 hot_list 1 次额度；搜索/LLM 走既有管线，LLM_RPM_LIMIT 令牌桶全局生效，
 *     变体间 300ms 间隔（fetchAnswers 内）原样适用
 *   - 固定 PREGENERATE_CONCURRENCY 个 worker（默认 4），完成一题立即补位，不打爆搜索限频
 *   - 单题失败 → 该题终态 failed，批次继续（docs/01 §4.1 原话：标记为失败并继续处理后续题目）
 *   - 已 ready 的题幂等跳过；INSERT 竞争失败（他处持有）不抢不重跑（§6.3 同路径）
 */

import { env } from './env'
import { log, errFields } from './log'
import { hotList, isLive } from './zhihu/client'
import { cacheQuestionTitle, getAnalysis, getJob, listHotQuestions, upsertHotQuestions } from './repo'
import { isRunningHere, STALE_GRACE_MS, startRunnerAwait, tryAcquire } from './jobs'
import { nowIso, parseIso, todayKey } from './time'

/** 批内并发度（默认 4）；搜索与 LLM 各自仍受客户端限流/令牌桶约束 */
const PREGENERATE_CONCURRENCY = env.PREGENERATE_CONCURRENCY

/** 剥掉站点后缀（与 routes/search.ts 同口径；实测 hot_list 标题一般已无后缀，防御性保留） */
function cleanHotTitle(raw: string): string {
  return raw.replace(/\s*[-–—]\s*知乎\s*$/u, '').trim()
}

export interface PregenerateReport {
  date: string
  topN: number
  /** hot_list 返回的问题类条目数 */
  fetched: number
  /** 已 ready 幂等跳过 */
  skippedReady: number
  /** 本进程启动 runner 并等待跑完的题数 */
  started: number
  /** INSERT 竞争失败（他处 worker 持有，不抢） */
  busyElsewhere: number
  /** failed 终态题（不自动重跑） */
  skippedFailed: number
  /** started 中最终 failed 的题数（单题失败不阻塞批次的直接证据） */
  endedFailed: number
  elapsedMs: number
}

/**
 * 预生成批次核心：对给定 {qid,title} 列表逐题参与 job 竞争并等待跑完。
 * 从 pregenerate 拆出来供失败隔离验证用（可注入坏 qid 而不必伪造 hot_list）。
 */
export async function runPregenerateBatch(
  date: string,
  items: Array<{ qid: string; title: string }>,
): Promise<PregenerateReport> {
  const started0 = Date.now()
  const report: PregenerateReport = {
    date,
    topN: items.length,
    fetched: items.length,
    skippedReady: 0,
    started: 0,
    busyElsewhere: 0,
    skippedFailed: 0,
    endedFailed: 0,
    elapsedMs: 0,
  }

  // 共享游标在 await 前同步领取；每个 worker 跑完当前题就取下一题，
  // 较慢的题只占自己的槽位，不让其他空闲 worker 等待整批结束。
  let cursor = 0
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const item = items[cursor++]!
      // 已 ready：幂等跳过，不重跑不重复消耗额度
      if (getAnalysis(date, item.qid)?.status === 'ready') {
        report.skippedReady++
        continue
      }
      // 与 GET/POST 主端点同一条 INSERT 竞争路径：抢到才跑
      const acq = tryAcquire(date, item.qid)
      if (!acq.owned || !acq.job) {
        if (getAnalysis(date, item.qid)?.status === 'failed') report.skippedFailed++
        else report.busyElsewhere++
        continue
      }
      report.started++
      // runJob 永不 reject（异常内部收敛为 failed）；完成后立即给下一题补位。
      await startRunnerAwait(date, item.qid, acq.job, item.title)
      if (getAnalysis(date, item.qid)?.status === 'failed') report.endedFailed++
    }
  }
  const workerCount = Math.min(items.length, PREGENERATE_CONCURRENCY)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))

  report.elapsedMs = Date.now() - started0
  log.info('pregenerate.batch.done', { ...report })
  return report
}

/**
 * 预生成一批热榜题：优先按选项复用本地候选，否则 hot_list(1 次额度) 抓取前 N 题。
 * titleHint 直接给（标题来自 hot_list 本身，零额外解析）；
 * hot_questions 与 question_titles 同步落库（/hot 与后续懒生成都有着落）。
 */
async function generateForDate(date: string, topN: number, reuseStored: boolean): Promise<PregenerateReport> {
  if (!isLive()) {
    throw new Error('pregenerate requires ZHIHU_LIVE=1（预生成全程走 live 闸，闸关时拒绝空转）')
  }
  if (topN <= 0) return runPregenerateBatch(date, [])
  log.info('pregenerate.start', { date, topN })

  if (reuseStored) {
    const stored = listHotQuestions(date).slice(0, topN)
    if (stored.length > 0) {
      // 只保存了榜单但分析中途停止时，也能从本地列表续跑，不重抓热榜。
      log.info('pregenerate.cache.hit', { date, count: stored.length })
      for (const it of stored) cacheQuestionTitle(it.qid, it.title, 'hot')
      const report = await runPregenerateBatch(date, stored)
      report.topN = topN
      return report
    }
  }

  const questions = await hotList(topN)
  const items = questions.slice(0, topN).map((q) => ({ qid: q.qid, title: cleanHotTitle(q.title) }))

  // hot_questions 落库：/hot 的候选集就位（ready 的才对外可见，listReadyHot JOIN analyses）
  const urlByQid = new Map(questions.map((q) => [q.qid, q.url]))
  upsertHotQuestions(
    date,
    items.map((it) => ({ date, qid: it.qid, title: it.title, url: urlByQid.get(it.qid) ?? '', fetched_at: nowIso() })),
  )
  // question_titles 预热（首次为准）：后续懒生成/重试的 titleHint 就有了着落
  for (const it of items) cacheQuestionTitle(it.qid, it.title, 'hot')

  const report = await runPregenerateBatch(date, items)
  report.topN = topN
  return report
}

/** 启动、cron 和本进程手动调用共用批次；异常后释放，后续调用仍可重试。 */
const activeBatches = new Map<string, Promise<PregenerateReport>>()

export function pregenerate(
  topN: number = env.PREGENERATE_TOP,
  options: { reuseStored?: boolean } = {},
): Promise<PregenerateReport> {
  const date = todayKey()
  const active = activeBatches.get(date)
  if (active) return active
  const batch = generateForDate(date, topN, options.reuseStored ?? false)
    .finally(() => { activeBatches.delete(date) })
  activeBatches.set(date, batch)
  return batch
}

/**
 * 刚重启时旧进程的 generating 锁还可能未过期。只在其到期后复查一次，
 * 仍走 tryAcquire，其他进程仍在更新的任务不抢占；failed 不自动重跑。
 */
function recheckInterruptedOnce(date: string): void {
  let delay = 0
  for (const item of listHotQuestions(date).slice(0, env.PREGENERATE_TOP)) {
    const job = getJob(date, item.qid)
    if (!job || (job.status !== 'pending' && job.status !== 'generating') || isRunningHere(date, item.qid)) continue
    const updated = parseIso(job.updated_at)
    const remaining = Number.isFinite(updated)
      ? updated + env.JOB_TIMEOUT_SEC * 1000 + STALE_GRACE_MS - Date.now()
      : 0
    delay = Math.max(delay, remaining + 1, 1)
  }
  if (!delay) return
  log.info('pregenerate.boot.recheckScheduled', { date, delayMs: delay })
  setTimeout(() => {
    // 不递归重试，也不因热榜抓取失败发起新的请求。
    void Promise.resolve().then(() => {
      if (todayKey() !== date || !isLive()) return
      return runPregenerateBatch(date, listHotQuestions(date).slice(0, env.PREGENERATE_TOP))
    })
      .catch((e) => log.warn('pregenerate.boot.recheckFailed', { date, ...errFields(e) }))
  }, delay).unref()
}

/** index 后台调用；外部接口失败不影响 HTTP 启动和当晚 cron。 */
export async function pregenerateOnBoot(): Promise<void> {
  const date = todayKey()
  if (!isLive() || env.PREGENERATE_TOP <= 0) {
    log.info('pregenerate.boot.skipped', { date, reason: 'live gate closed or PREGENERATE_TOP=0' })
    return
  }
  try {
    const report = await pregenerate(env.PREGENERATE_TOP, { reuseStored: true })
    log.info('pregenerate.boot.done', { ...report })
    if (report.busyElsewhere > 0) recheckInterruptedOnce(report.date)
  } catch (e) {
    log.warn('pregenerate.boot.failed', { date, ...errFields(e) })
  }
}

/* ------------------------------ 进程内 cron ------------------------------ */

/** 当日已跑守卫的 date 键（进程内状态，重启自然清零 → 当日首跑交给守卫判断） */
let cronLastRunDate = ''

/**
 * 距下一次 Asia/Shanghai 00:30 的毫秒数。东八区固定 UTC+8 无夏令时，
 * 用 todayKey（显式 Asia/Shanghai）拼当日 00:30，已过则 +1 天。
 */
export function msUntilNextPregenerate(now: number = Date.now()): number {
  const [y, m, d] = todayKey(now).split('-').map(Number)
  const todayTarget = Date.UTC(y!, m! - 1, d!, 0, 30, 0) - 8 * 3_600_000
  const target = now < todayTarget ? todayTarget : todayTarget + 86_400_000
  return target - now
}

async function cronTick(): Promise<void> {
  const date = todayKey()
  if (cronLastRunDate === date) {
    log.warn('pregenerate.cron.alreadyRan', { date })
    return
  }
  cronLastRunDate = date
  if (!isLive() || env.PREGENERATE_TOP <= 0) {
    // 闸关着就别空转：记一笔走人，下次 00:30 再试（手动脚本不受此限，可显式 --live）
    log.info('pregenerate.cron.skipped', { date, reason: 'live gate closed or PREGENERATE_TOP=0' })
    return
  }
  try {
    const r = await pregenerate(env.PREGENERATE_TOP, { reuseStored: true })
    log.info('pregenerate.cron.done', { ...r, date: todayKey() })
  } catch (e) {
    log.warn('pregenerate.cron.failed', { date: todayKey(), ...errFields(e) })
  }
}

function reArmCron(): void {
  const delay = msUntilNextPregenerate()
  log.info('pregenerate.cron.armed', { nextInMs: delay, nextDate: todayKey(Date.now() + delay) })
  setTimeout(() => {
    void cronTick().finally(reArmCron)
  }, delay)
}

/** 进程内定时器启动入口（index.ts boot 时调用一次） */
export function startPregenerateCron(): void {
  cronLastRunDate = ''
  reArmCron()
}
