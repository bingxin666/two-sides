import { PipelineError, type PipelineContext } from './agents/types'
import type { Stage } from '@two-sides/contract'
import { log } from './log'

export type PipelinePhase = 'fetchAnswers' | 'extract' | 'merge' | 'orient' | 'summary' | 'discoverTopics' | 'classifyAnswers'

/**
 * 阶段预算表（2026-09-13 按 600s 整题预算重新标定）
 *
 * capMs    本阶段绝对上限（含排队、重试、限流等待、响应体读取与校验）
 * reserveMs 本阶段结束后必须为下游保留的时间下限
 *
 * 参考口径：产品入口只剩热榜（无用户输入），单题预算 180s → 600s，
 * 检索路数 ≤4、样本池 ≤40 条，因此每阶段的 cap 与 reserve 同步放宽。
 * reserveScale（0..1）= 当前整题剩余预算 / 600s：整题预算被调小时，
 * reserve 等比缩短；cap 始终是上限，不会因此变大。
 * 设更短的 ANALYSIS_JOB_TIMEOUT_SEC 时这套表照常收敛（downstream 优先）。
 */
/**
 * 预算标定基准（毫秒）—— PHASE_BUDGETS 里的 cap/reserve 都是按这个整题预算标定的。
 *
 * 与 ANALYSIS_JOB_TIMEOUT_SEC 的默认值保持一致，但**故意独立于 env**：
 * reserveScale 是「当前剩余 / 基准」，基准若跟着 env 走，把整题预算调成 1s 时
 * scale 仍≈1，reserve 会原样生效（300s 的 reserve 撞进 1s 的预算里 → 阶段刚进门就超时）。
 * 固定基准下，短预算自动等比缩短 reserve，长预算则被 min(1, ·) 截住（reserve 是下限，不放大）。
 * 改动 PHASE_BUDGETS 的标定口径时，这里要一起改。
 */
export const BUDGET_REFERENCE_MS = 600_000

// At the default 600s job limit, protect the necessary downstream stages.
// Shorter configured jobs scale reserves proportionally; caps remain upper bounds.
export const PHASE_BUDGETS = {
  // 获取内容：LLM 扩写（≤10s）+ 多路并行搜索 + URL 强校验 + 可选救援
  fetchAnswers: { capMs: 240_000, reserveMs: 300_000 },
  extract: { capMs: 150_000, reserveMs: 150_000 },
  merge: { capMs: 120_000, reserveMs: 60_000 },
  orient: { capMs: 150_000, reserveMs: 30_000 },
  summary: { capMs: 60_000, reserveMs: 5_000 },
  // 两轮路径：一次主题发现要吃下整个样本池（≤40 条），留足上限
  discoverTopics: { capMs: 120_000, reserveMs: 150_000 },
  classifyAnswers: { capMs: 150_000, reserveMs: 30_000 },
} as const

/** One absolute deadline for the whole phase, shared by all concurrent units. */
export async function runWithBudget<T>(
  ctx: PipelineContext,
  phase: PipelinePhase,
  reserveScale: number,
  run: (scoped: PipelineContext) => Promise<T>,
): Promise<T> {
  const started = performance.now()
  const { capMs, reserveMs } = PHASE_BUDGETS[phase]
  const deadlineAt = Math.min(
    Date.now() + capMs,
    (ctx.deadlineAt ?? Infinity) - reserveMs * reserveScale,
  )
  const stage: Stage = phase === 'fetchAnswers' ? 'extract' : phase === 'summary' ? 'render'
    : phase === 'discoverTopics' ? 'merge' : phase === 'classifyAnswers' ? 'orient' : phase
  const timeout = () => new PipelineError(`${phase} budget exhausted`, 'timeout', stage, true)
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  let outcome = 'ok'
  try {
    if (ctx.signal.aborted || Date.now() >= deadlineAt) throw timeout()
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        controller.abort()
        reject(timeout())
      }
      ctx.signal.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(onAbort, Math.max(0, deadlineAt - Date.now()))
      if (ctx.signal.aborted) onAbort()
    })
    const scoped: PipelineContext = {
      ...ctx,
      deadlineAt,
      signal: controller.signal,
      report: (p) => { if (!controller.signal.aborted) ctx.report(p) },
      note: (event, fields) => { if (!controller.signal.aborted) ctx.note(event, fields) },
    }
    const value = await Promise.race([Promise.resolve().then(() => {
      if (controller.signal.aborted) throw timeout()
      return run(scoped)
    }), cancelled])
    // Covers synchronous parsing/validation that holds the event loop past the timer.
    if (ctx.signal.aborted || Date.now() >= deadlineAt) throw timeout()
    return value
  } catch (e) {
    outcome = e instanceof PipelineError && e.mapped === 'timeout' ? 'timeout' : 'failed'
    throw e
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (onAbort) ctx.signal.removeEventListener('abort', onAbort)
    controller.abort()
    const fields = {
      qid: ctx.qid, date: ctx.date, stage: phase, outcome,
      elapsedMs: Math.round(performance.now() - started),
      remainingMs: ctx.deadlineAt === undefined ? undefined : Math.max(0, ctx.deadlineAt - Date.now()),
    }
    log.info('pipeline.stage.done', fields)
    ctx.note('stage.done', fields)
  }
}
