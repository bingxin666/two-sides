/**
 * 管线编排器（扇出—扇入）
 *
 * docs/03 §4：
 *   01 提取：批量化（一次 3–5 条回答），信号量 4；单批失败丢弃该批并记 detail，不阻塞其他批
 *   02 归并：1 路串行；失败 → 整体 failed(llm_error)
 *   03 取向：每判断 1 个，信号量 6；部分失败保留 orientStatus:"partial"，不阻塞整体
 *   04 综述：1 路；直答优先，额度耗尽降级 summaryFallback
 *
 * 实现选择由 createAgents(mode) 决定：
 *   fake（D0 默认，确定性、不联网） / llm（D1 真实调用）
 * 两者共用同一组 PipelineAgents 接口，本文件不含任何模型或网络细节。
 */

import type { Analysis, Judgment } from '@two-sides/contract'
import { Analysis as AnalysisSchema, checkCountingRules } from '@two-sides/contract'
import { createFakeAgents } from './agents/fake'
import {
  mapPool,
  PipelineError,
  type MergedJudgment,
  type OrientedJudgment,
  type PipelineAgents,
  type PipelineContext,
  type RawAnswer,
} from './agents/types'
import { log } from './log'

/** 01 提取：每批回答数（docs/03 §4.1：3–5 条） */
const EXTRACT_BATCH_SIZE = 4
const EXTRACT_CONCURRENCY = 4
/** 03 取向并发 */
const ORIENT_CONCURRENCY = 6

/**
 * 综述降级计数（进程内累计，评审期观察降化率；也可挂到 /health 之外的诊断口）。
 * 只增不减，不参与任何业务判断。
 */
export const summaryDegradation = { count: 0 }

export function createAgents(mode: 'fake' | 'llm'): PipelineAgents {
  if (mode === 'fake') return createFakeAgents()
  // D1：真实 LLM 实现，签名与 fake 完全一致
  throw new PipelineError(
    'llm pipeline not implemented yet (D1)',
    'llm_error',
    'extract',
    true,
  )
}

/** 01 输入分批 */
export function batchAnswers(answers: RawAnswer[], size = EXTRACT_BATCH_SIZE): RawAnswer[][] {
  const out: RawAnswer[][] = []
  for (let i = 0; i < answers.length; i += size) out.push(answers.slice(i, i + size))
  return out
}

/**
 * 跑完四阶段，返回符合契约的 Analysis。
 * 任何不可恢复失败抛 PipelineError（由 jobs.ts 映射成终态 failed）。
 */
export async function runPipeline(
  agents: PipelineAgents,
  ctx: PipelineContext,
): Promise<Analysis> {
  // ctx.note 由 runner 收集进 job.detail（非致命事件，不改变终态）
  const note = (event: string, fields?: Record<string, unknown>) => {
    log.debug('pipeline.note', { qid: ctx.qid, event })
    ctx.note(event, fields)
  }

  /* ---------- 获取内容 ---------- */
  const { question, answers } = await agents.fetchAnswers(ctx.qid, ctx)
  if (answers.length === 0) {
    throw new PipelineError('未取到任何回答', 'zhihu_error', 'extract', true)
  }
  ctx.report({ stage: 'extract', stageRatio: 0, sampleCount: answers.length, judgmentsDone: 0, judgmentsTotal: 0 })

  /* ---------- 01 提取 ---------- */
  const batches = batchAnswers(answers)
  const extracted = await mapPool(
    batches,
    EXTRACT_CONCURRENCY,
    (batch) => agents.extract(batch, ctx),
    (_batch, index, e) => {
      note(`extract.batch.${index}.failed`, {
        reason: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200),
      })
    },
  )
  const judgmentsRaw = extracted
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .flat()
  ctx.report({
    stage: 'extract',
    stageRatio: 1,
    sampleCount: answers.length,
    judgmentsDone: 0,
    judgmentsTotal: 0,
  })

  if (judgmentsRaw.length === 0) {
    // docs/03 §6.1：全部提取失败 → failed
    throw new PipelineError('全部提取批次失败', 'llm_error', 'extract', true)
  }
  note('extract.done', { batches: batches.length, extracted: judgmentsRaw.length })

  /* ---------- 02 归并 ---------- */
  ctx.report({ stage: 'merge', stageRatio: 0, judgmentsTotal: 0 })
  let merged: MergedJudgment[]
  try {
    merged = await agents.merge(judgmentsRaw, ctx)
  } catch (e) {
    throw new PipelineError(
      `归并失败: ${e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200)}`,
      'llm_error',
      'merge',
      true,
    )
  }
  ctx.report({ stage: 'merge', stageRatio: 1, judgmentsTotal: merged.length })

  /* ---------- 03 取向 ---------- */
  let oriented = 0
  const orientResults = await mapPool(
    merged,
    ORIENT_CONCURRENCY,
    (j) => agents.orient(j, answers, ctx),
    (j, _i, e) => {
      note(`orient.${j.id}.failed`, {
        reason: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200),
      })
    },
  )
  const judgments: OrientedJudgment[] = []
  for (const r of orientResults) {
    oriented++
    if (r === null) continue // 部分失败：该判断整体缺席，不进结果
    judgments.push(r)
    ctx.report({
      stage: 'orient',
      stageRatio: oriented / Math.max(1, merged.length),
      sampleCount: answers.length,
      judgmentsDone: judgments.length,
      judgmentsTotal: merged.length,
    })
  }
  if (judgments.length === 0) {
    throw new PipelineError('全部判断归位失败', 'llm_error', 'orient', true)
  }
  note('orient.done', { total: merged.length, ok: judgments.length })

  /* ---------- 04 综述（题级，docs/01 §8 第 7 条：100/日 ÷ 30 题 = 每题 1 次） ---------- */
  ctx.report({ stage: 'render', stageRatio: 0.2, judgmentsTotal: judgments.length })
  let summaryText: string | undefined
  let summarySource: 'zhida' | 'fallback' | undefined
  try {
    const s = await agents.summarize(answers, ctx)
    if (s.summary) {
      summaryText = s.summary
      summarySource = s.source ?? 'fallback'
    }
  } catch (e) {
    // ⚠️ 有意偏离 docs/03 §6.1（「直答与回退都失败 → failed」），2026-09-12 team-lead 裁决采纳：
    // 综述是可选字段，一次失败不该报废整批预生成 —— 直答额度只有 100/日（docs/03 §8.5 最紧的一项），
    // 若因它把每道题都置 failed，30 题预生成会整批报废、懒生成路径也会被同一条额度拖死。
    // 降级行为：summary / summarySource 缺省，前端按「无解读」展示（ui 已同步）。
    // 评审期观察降级率：summaryDegradation.count + 下面的结构化日志。
    summaryDegradation.count++
    log.warn('pipeline.summary.degraded', {
      qid: ctx.qid,
      total: summaryDegradation.count,
      reason: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200),
    })
    note('summary.degraded', { total: summaryDegradation.count })
  }

  /* ---------- 组装 ---------- */
  const judgmentsOut: Judgment[] = judgments
    // §5.2 规则 6：participantCount === 0 的判断直接丢弃
    .filter((j) => j.participantCount > 0)
    .map<Judgment>((j) => {
      const { relatedAnswerIds: _drop, ...rest } = j
      // 04 综述是题级一次调用，产出后拆分挂到每条 judgment.summary（额度：100/日 ÷ 30 题）。
      // D1 真实直答路径 summarySource 必须标 'zhida'，降级标 'fallback' —— 前端据此双态展示。
      if (summaryText) {
        return { ...rest, summary: summaryText, summarySource: summarySource ?? 'fallback' }
      }
      return rest
    })

  if (judgmentsOut.length === 0) {
    throw new PipelineError('没有可呈现的判断', 'parse_error', 'render', true)
  }

  const analysis: Analysis = {
    qid: ctx.qid,
    question,
    date: ctx.date,
    sampleCount: answers.length,
    judgments: judgmentsOut,
  }

  // 出库前校验：结构 + 计数口径（§5.2 的 9 条硬规则）
  const parsed = AnalysisSchema.safeParse(analysis)
  if (!parsed.success) {
    throw new PipelineError(
      `Analysis 结构校验失败: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
      'parse_error',
      'render',
      true,
    )
  }
  const violations = checkCountingRules(parsed.data)
  if (violations.length > 0) {
    throw new PipelineError(`计数口径违规: ${violations[0]}`, 'parse_error', 'render', true)
  }

  ctx.report({
    stage: 'render',
    stageRatio: 1,
    sampleCount: answers.length,
    judgmentsDone: judgmentsOut.length,
    judgmentsTotal: judgmentsOut.length,
  })

  log.info('pipeline.done', {
    qid: ctx.qid,
    answers: answers.length,
    judgments: judgmentsOut.length,
    summarySource: summarySource ?? 'none',
  })

  return parsed.data
}
