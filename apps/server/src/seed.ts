/**
 * 开发期种子脚本（不自动执行）：bun run seed
 *
 * 往当日写入 N 个「已 ready」的 fake 分析快照 + hot_questions，
 * 让前端在 D0 就能拿到 /hot 与 /analysis 的真实响应做联调。
 *
 * 只在显式执行时写库，服务启动路径不会调用它；
 * 产出的 data 与懒生成路径同源（agents/fake.generateFakeAnalysis），口径一致。
 *
 * 用法：
 *   bun run seed            # 默认 12 题
 *   SEED_COUNT=30 bun run seed
 */

import { Analysis as AnalysisSchema, checkCountingRules } from '@two-sides/contract'
import { generateFakeAnalysis } from './agents/fake'
import { closeDb } from './db'
import { log } from './log'
import { beginRun, getAnalysis, insertJobIgnore, markReady, upsertHotQuestions } from './repo'
import { randomUUID } from 'node:crypto'
import { todayKey, nowIso } from './time'

const DATE = todayKey()
const COUNT = Math.max(1, Math.min(30, Number(process.env.SEED_COUNT ?? 12)))
/** 起始 qid：连续 id，方便前端手测 */
const START_QID = Number(process.env.SEED_START_QID ?? 100000001)

const TITLES = [
  '为什么现在越来越多年轻人选择不结婚？',
  '人工智能会不会让普通人的工作变得没有意义？',
  '长期996真的是个人选择吗？',
  '读研和直接工作，哪个更值得？',
  '大城市的房价还会继续涨吗？',
  '成年人应该如何面对父母的期待？',
  '开源社区贡献到底值不值得投入时间？',
  '短视频是不是在降低我们的思考能力？',
  '所谓「稳定工作」在当下还存在吗？',
  '我们应该为环保多付钱吗？',
  '远程办公是效率提升还是管理失控？',
  '普通人还有必要学编程吗？',
  '为什么好的产品总是先在小圈子里流行？',
  '公共讨论中，情绪和事实哪个更有力量？',
  '三十岁转行，代价到底有多大？',
]

const hot: Array<{ date: string; qid: string; title: string; url: string; fetched_at: string }> = []

for (let i = 0; i < COUNT; i++) {
  const qid = String(START_QID + i)
  const analysis = generateFakeAnalysis(qid, DATE)

  const parsed = AnalysisSchema.safeParse(analysis)
  if (!parsed.success) {
    log.error('seed.invalid', { qid, issue: parsed.error.issues[0]?.message ?? 'unknown' })
    continue
  }
  const violations = checkCountingRules(parsed.data)
  if (violations.length > 0) {
    log.error('seed.countingViolation', { qid, violation: violations[0] })
    continue
  }

  // 直接写快照（跳过 runner，因为这是确定性数据、不需要进度）
  // 先占一个 job 行（UNIQUE(date,qid) 依然是锁），再把它与 analyses 一起置 ready
  const jobId = randomUUID()
  // analyses 行是权威状态载体，必须先存在，markReady 才能把它置 ready
  beginRun(DATE, qid, 1)
  insertJobIgnore({
    id: jobId,
    date: DATE,
    qid,
    stage: 'extract',
    attempts: 1,
    owner: 'seed',
  })
  markReady(jobId, DATE, qid, JSON.stringify(parsed.data), {
    stage: 'render',
    stageRatio: 1,
    sampleCount: parsed.data.sampleCount,
    judgmentsDone: parsed.data.judgments.length,
    judgmentsTotal: parsed.data.judgments.length,
    detail: [{ event: 'seed', t: nowIso() }],
  })

  hot.push({
    qid,
    date: DATE,
    title: TITLES[i % TITLES.length] ?? `问题 ${qid}`,
    url: `https://www.zhihu.com/question/${qid}`,
    fetched_at: nowIso(),
  })
}

upsertHotQuestions(DATE, hot)

const sample = getAnalysis(DATE, String(START_QID))
log.info('seed.done', {
  date: DATE,
  seeded: hot.length,
  firstQid: String(START_QID),
  firstStatus: sample?.status ?? 'none',
  judgments: sample?.data ? JSON.parse(sample.data).judgments.length : 0,
})

closeDb()
