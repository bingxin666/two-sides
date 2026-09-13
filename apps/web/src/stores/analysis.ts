import { defineStore } from 'pinia'
import { ref } from 'vue'
import {
  ERROR_COPY,
  type Analysis,
  type ErrorCode,
  type ProgressError,
  type ProgressResp,
} from '@two-sides/contract'

import { getAnalysis, retryAnalysis } from '@/api'
import { ApiError } from '@/api/http'

export type AnalysisPhase = 'idle' | 'loading' | 'generating' | 'ready' | 'failed'

/** 轮询参数：基础间隔 1.4s，每 8 轮 ×1.3 退避，封顶 4s */
const POLL_BASE_MS = 1400
const POLL_MAX_MS = 4000
const POLL_BACKOFF_EVERY = 8
/**
 * 总时限模型（不设轮数上限）：真实管线单题 60–150s+（极端 LLM 慢），5 分钟封顶。
 * 超时只是前端停止等待（docs/03 §6.3「取消」语义）—— 后端任务继续跑，
 * 快照落地后重进即秒开；用户点「重试」走 POST 幂等恢复轮询。
 */
const POLL_DEADLINE_MS = 5 * 60_000
/** 连续网络异常多少次后放弃（转成 failed-ish 提示，不再空转）；任何一次成功即清零 */
const MAX_NET_ERRORS = 5
const SUMMARY_POLL_MS = 2000
const SUMMARY_DEADLINE_MS = 60_000
const SUMMARY_MAX_ERRORS = 3

function makeError(code: ErrorCode): ProgressError {
  const copy = ERROR_COPY[code]
  return { code, message: copy.message, retryable: copy.retryable }
}

function isSnapshot(res: Analysis | ProgressResp): res is Analysis {
  return Array.isArray((res as Analysis).judgments)
}

function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError'
}

/**
 * zod 校验失败（真实 LLM 数据违反契约、或响应形状整体不对）是确定性错误：
 * 同一快照重试结果相同，重试只是烧时间 —— 直接终态 parse_error，不进重试计数。
 */
function isContractViolation(e: unknown): boolean {
  return e instanceof Error && e.name === 'ZodError'
}

export const useAnalysisStore = defineStore('analysis', () => {
  const phase = ref<AnalysisPhase>('idle')
  const analysis = ref<Analysis | null>(null)
  const progress = ref<ProgressResp | null>(null) // 202 时的进度体
  const error = ref<ProgressError | null>(null) // 202 且 status === 'failed' 时的 error
  const selectedJudgmentId = ref<string | null>(null)
  const summaryPolling = ref(false)

  /**
   * 轮询现场：
   *  - generation 是代际 token，切换 qid / reset / cancelPolling 都会自增，
   *    旧一轮的回调回来时发现对不上就自行放弃（等价于取消上一个轮询）。
   *  - controller 用于 abort 正在飞的那一个请求。
   */
  let generation = 0
  let controller: AbortController | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let currentQid: string | null = null
  let currentTitle: string | null = null
  let pollStartAt = 0
  let rounds = 0
  let netErrors = 0
  let polling = false
  let summaryStartAt = 0
  let summaryErrors = 0
  let summaryDeadlineTimer: ReturnType<typeof setTimeout> | null = null

  function stopTimers(): void {
    if (summaryDeadlineTimer !== null) {
      clearTimeout(summaryDeadlineTimer)
      summaryDeadlineTimer = null
    }
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (controller) {
      controller.abort()
      controller = null
    }
  }

  /** 作废当前代际并停掉在飞的轮询（T1 的「取消」用它） */
  function cancelPolling(): void {
    generation += 1
    polling = false
    summaryPolling.value = false
    stopTimers()
  }

  function settle(): void {
    polling = false
    summaryPolling.value = false
    stopTimers()
  }

  function toFailed(err: ProgressError): void {
    error.value = err
    progress.value = null
    phase.value = 'failed'
    settle()
  }

  function errorFrom(e: unknown): ProgressError {
    // 404：qid 非法或非问答页 —— 请求本身不可满足，not_found 且永不给重试按钮
    if (e instanceof ApiError && (e.status === 404 || e.code === 404)) return makeError('not_found')
    return makeError('zhihu_error')
  }

  /** Ready snapshots stay visible while optional interpretation catches up. */
  function scheduleSummary(qid: string, my: number, title: string | undefined): void {
    if (my !== generation || !summaryPolling.value) return
    const remaining = SUMMARY_DEADLINE_MS - (Date.now() - summaryStartAt)
    if (remaining <= 0 || summaryErrors >= SUMMARY_MAX_ERRORS) {
      settle()
      return
    }
    timer = setTimeout(() => {
      timer = null
      void runSummaryRound(qid, my, title)
    }, Math.min(SUMMARY_POLL_MS, remaining))
  }

  function startSummaryPolling(qid: string, my: number, title: string | undefined): void {
    summaryStartAt = Date.now()
    summaryErrors = 0
    polling = true
    summaryPolling.value = true
    // The independent deadline also cancels a request that is still in flight.
    summaryDeadlineTimer = setTimeout(() => { if (my === generation) settle() }, SUMMARY_DEADLINE_MS)
    scheduleSummary(qid, my, title)
  }

  async function runSummaryRound(qid: string, my: number, title: string | undefined): Promise<void> {
    if (my !== generation || !summaryPolling.value) return
    const ctrl = new AbortController()
    controller = ctrl
    try {
      const res = await getAnalysis(qid, {
        signal: ctrl.signal, title,
        timeoutMs: Math.max(1, Math.min(8000, SUMMARY_DEADLINE_MS - (Date.now() - summaryStartAt))),
      })
      if (my !== generation || !summaryPolling.value || ctrl.signal.aborted) return
      if (isSnapshot(res) && res.qid === qid && res.date === analysis.value?.date) {
        analysis.value = res
        summaryErrors = 0
        if (res.summaryStatus !== 'pending') {
          settle()
          return
        }
      } else {
        // A regeneration or unexpected response cannot replace the ready view.
        summaryErrors += 1
      }
      scheduleSummary(qid, my, title)
    } catch (e) {
      if (my !== generation || !summaryPolling.value || ctrl.signal.aborted) return
      summaryErrors += 1
      scheduleSummary(qid, my, title)
    } finally {
      if (controller === ctrl) controller = null
    }
  }

  function scheduleNext(qid: string, my: number, title: string | undefined): void {
    if (my !== generation) return
    rounds += 1
    // 总时限封顶：超过 5 分钟置 failed（timeout，可重试），不再让用户无限转
    if (Date.now() - pollStartAt > POLL_DEADLINE_MS) {
      toFailed(makeError('timeout'))
      return
    }
    const factor = Math.pow(1.3, Math.floor(rounds / POLL_BACKOFF_EVERY))
    const wait = Math.min(POLL_MAX_MS, Math.round(POLL_BASE_MS * factor))
    timer = setTimeout(() => {
      timer = null
      void runRound(qid, my, title)
    }, wait)
  }

  async function runRound(qid: string, my: number, title: string | undefined): Promise<void> {
    if (my !== generation) return

    const ctrl = new AbortController()
    controller = ctrl
    try {
      const res = await getAnalysis(qid, { signal: ctrl.signal, title })
      if (my !== generation) return

      if (isSnapshot(res)) {
        analysis.value = res
        progress.value = null
        error.value = null
        phase.value = 'ready'
        settle()
        if (res.summaryStatus === 'pending') startSummaryPolling(qid, my, title)
        return
      }

      // 202：进度体。failed 立即停止轮询，其余继续
      progress.value = res
      if (res.status === 'failed') {
        toFailed(res.error ?? makeError('llm_error'))
        return
      }

      netErrors = 0
      phase.value = 'generating'
      scheduleNext(qid, my, title)
    } catch (e) {
      if (my !== generation || isAbort(e)) return
      // 契约违规（响应形状/字段值不对）：确定性错误，直接终态不重试
      if (isContractViolation(e)) {
        toFailed(makeError('parse_error'))
        return
      }
      netErrors += 1
      if (netErrors >= MAX_NET_ERRORS) {
        toFailed(errorFrom(e))
        return
      }
      // 网络抖动不打断轮询，按退避继续
      scheduleNext(qid, my, title)
    } finally {
      if (controller === ctrl) controller = null
    }
  }

  /**
   * GET 主端点；200 → ready，202 → 自动轮询至 ready / failed。幂等可重入。
   * title：冷题标题提示（/search 候选），参与幂等判断 —— 同 qid 不同 title
   * 走的是服务端不同路径（question_titles 缓存语义），不允许短路返回。
   */
  async function load(qid: string, opts?: { title?: string }): Promise<void> {
    const title = opts?.title
    // Reopening a pending ready snapshot resumes only its optional background work.
    if (currentQid === qid && currentTitle === (title ?? null)) {
      if (phase.value === 'ready') {
        if (analysis.value?.summaryStatus === 'pending' && !polling) startSummaryPolling(qid, generation, title)
        return
      }
      if (polling) return
    }

    cancelPolling()
    const my = generation
    currentQid = qid
    currentTitle = title ?? null
    pollStartAt = Date.now()
    rounds = 0
    netErrors = 0
    analysis.value = null
    progress.value = null
    error.value = null
    selectedJudgmentId.value = null
    phase.value = 'loading'
    polling = true

    await runRound(qid, my, title)
  }

  /** POST 重试；成功后恢复轮询。title 语义同 load。 */
  async function retry(qid: string, opts?: { title?: string }): Promise<void> {
    const title = opts?.title
    cancelPolling()
    const my = generation
    currentQid = qid
    currentTitle = title ?? null
    pollStartAt = Date.now()
    rounds = 0
    netErrors = 0
    error.value = null
    phase.value = 'loading'
    polling = true

    try {
      const res = await retryAnalysis(qid, false, title)
      if (my !== generation) return
      progress.value = res
      if (res.status === 'failed') {
        toFailed(res.error ?? makeError('llm_error'))
        return
      }
      phase.value = 'generating'
      scheduleNext(qid, my, title)
    } catch (e) {
      if (my !== generation || isAbort(e)) return
      toFailed(errorFrom(e))
    }
  }

  function select(id: string | null): void {
    selectedJudgmentId.value = id
  }

  function reset(): void {
    cancelPolling()
    currentQid = null
    currentTitle = null
    pollStartAt = 0
    rounds = 0
    netErrors = 0
    phase.value = 'idle'
    analysis.value = null
    progress.value = null
    error.value = null
    selectedJudgmentId.value = null
  }

  return {
    phase,
    analysis,
    progress,
    error,
    selectedJudgmentId,
    summaryPolling,
    load,
    retry,
    select,
    reset,
    cancelPolling,
  }
})
