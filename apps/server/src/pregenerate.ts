/**
 * 热榜预生成（D2-1，docs/04）
 *
 * 目标：让 GET /hot 在当天第一次被访问前就有真实数据 —— 00:30（Asia/Shanghai）
 * 拉热榜前 N 题逐题跑管线，用户白天点开热榜卡即 ready，不用现场等 1–2 分钟。
 *
 * 三件套：
 *   1. pregenerate(topN)          —— 批次函数（本模块），cron 与手动脚本共用
 *   2. pregenerate:run --top N    —— 手动脚本（src/pregenerate-run.ts，双闸：--live 才真跑）
 *   3. startPregenerateCron()     —— 进程内 Bun timer 对齐每日 00:30，触发后 re-arm 次日
 *
 * 纪律（docs/01 §4.1 / team-lead 拍板）：
 *   - 全程走 ZHIHU_LIVE 闸：hotList 自带闸，闸关时 cron tick 只记日志不硬跑
 *   - 每批 hot_list 1 次额度；搜索/LLM 走既有管线，LLM_RPM_LIMIT 令牌桶全局生效，
 *     变体间 300ms 间隔（fetchAnswers 内）原样适用
 *   - 批内小并发（≤2，PREGENERATE_CONCURRENCY），跑完一批再放下一批，不打爆搜索限频
 *   - 单题失败 → 该题终态 failed，批次继续（docs/01 §4.1 原话：标记为失败并继续处理后续题目）
 *   - 已 ready 的题幂等跳过；INSERT 竞争失败（他处持有）不抢不重跑（§6.3 同路径）
 */

import { env } from './env'
import { log, errFields } from './log'
import { hotList, isLive } from './zhihu/client'
import { cacheQuestionTitle, getAnalysis, upsertHotQuestions } from './repo'
import { startRunnerAwait, tryAcquire } from './jobs'
import { nowIso, todayKey } from './time'

/** 批内并发度：≤2，避免打爆 zhihu_search 限频（30001） */
const PREGENERATE_CONCURRENCY = 2

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

  // 小并发分批：每批 PREGENERATE_CONCURRENCY 题，批内 Promise.all，批间串行
  for (let i = 0; i < items.length; i += PREGENERATE_CONCURRENCY) {
    const chunk = items.slice(i, i + PREGENERATE_CONCURRENCY)
    await Promise.all(
      chunk.map(async (item) => {
        // 已 ready：幂等跳过，不重跑不重复消耗额度
        if (getAnalysis(date, item.qid)?.status === 'ready') {
          report.skippedReady++
          return
        }
        // 与 GET/POST 主端点同一条 INSERT 竞争路径：抢到才跑
        const acq = tryAcquire(date, item.qid)
        if (!acq.owned || !acq.job) {
          if (getAnalysis(date, item.qid)?.status === 'failed') report.skippedFailed++
          else report.busyElsewhere++
          return
        }
        report.started++
        // runJob 永不 reject（异常内部收敛为 failed）；跑完一个再放下一个
        await startRunnerAwait(date, item.qid, acq.job, item.title)
        if (getAnalysis(date, item.qid)?.status === 'failed') report.endedFailed++
      }),
    )
  }

  report.elapsedMs = Date.now() - started0
  log.info('pregenerate.batch.done', { ...report })
  return report
}

/**
 * 预生成一批热榜题：hot_list(1 次额度) → 前 N 题 → 逐题跑现有 job 机制。
 * titleHint 直接给（标题来自 hot_list 本身，零额外解析）；
 * hot_questions 与 question_titles 同步落库（/hot 与后续懒生成都有着落）。
 */
export async function pregenerate(topN: number = env.PREGENERATE_TOP): Promise<PregenerateReport> {
  if (!isLive()) {
    throw new Error('pregenerate requires ZHIHU_LIVE=1（预生成全程走 live 闸，闸关时拒绝空转）')
  }
  const date = todayKey()
  log.info('pregenerate.start', { date, topN })

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
  if (!isLive()) {
    // 闸关着就别空转：记一笔走人，下次 00:30 再试（手动脚本不受此限，可显式 --live）
    log.info('pregenerate.cron.skipped', { date, reason: 'zhihu live gate closed' })
    return
  }
  try {
    const r = await pregenerate(env.PREGENERATE_TOP)
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
