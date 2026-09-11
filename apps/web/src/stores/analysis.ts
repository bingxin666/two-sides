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

/** 轮询参数：基础间隔 1.4s，每 8 轮 ×1.3 退避，封顶 4s，最多 40 轮兜底 */
const POLL_BASE_MS = 1400
const POLL_MAX_MS = 4000
const POLL_BACKOFF_EVERY = 8
const POLL_MAX_ROUNDS = 40
/** 连续网络异常多少次后放弃（转成 failed-ish 提示，不再空转） */
const MAX_NET_ERRORS = 5

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

export const useAnalysisStore = defineStore('analysis', () => {
  const phase = ref<AnalysisPhase>('idle')
  const analysis = ref<Analysis | null>(null)
  const progress = ref<ProgressResp | null>(null) // 202 时的进度体
  const error = ref<ProgressError | null>(null) // 202 且 status === 'failed' 时的 error
  const selectedJudgmentId = ref<string | null>(null)

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
  let rounds = 0
  let netErrors = 0
  let polling = false

  function stopTimers(): void {
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
    stopTimers()
  }

  function settle(): void {
    polling = false
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

  function scheduleNext(qid: string, my: number): void {
    if (my !== generation) return
    rounds += 1
    if (rounds > POLL_MAX_ROUNDS) {
      toFailed(makeError('timeout'))
      return
    }
    const factor = Math.pow(1.3, Math.floor(rounds / POLL_BACKOFF_EVERY))
    const wait = Math.min(POLL_MAX_MS, Math.round(POLL_BASE_MS * factor))
    timer = setTimeout(() => {
      timer = null
      void runRound(qid, my)
    }, wait)
  }

  async function runRound(qid: string, my: number): Promise<void> {
    if (my !== generation) return

    const ctrl = new AbortController()
    controller = ctrl
    try {
      const res = await getAnalysis(qid, { signal: ctrl.signal })
      if (my !== generation) return

      if (isSnapshot(res)) {
        analysis.value = res
        progress.value = null
        error.value = null
        phase.value = 'ready'
        settle()
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
      scheduleNext(qid, my)
    } catch (e) {
      if (my !== generation || isAbort(e)) return
      netErrors += 1
      if (netErrors >= MAX_NET_ERRORS) {
        toFailed(errorFrom(e))
        return
      }
      // 网络抖动不打断轮询，按退避继续
      scheduleNext(qid, my)
    } finally {
      if (controller === ctrl) controller = null
    }
  }

  /** GET 主端点；200 → ready，202 → 自动轮询至 ready / failed。幂等可重入。 */
  async function load(qid: string): Promise<void> {
    // 同一 qid：已就绪或仍在轮询中 → 直接返回，不重复触发
    if (currentQid === qid && (phase.value === 'ready' || polling)) return

    cancelPolling()
    const my = generation
    currentQid = qid
    rounds = 0
    netErrors = 0
    analysis.value = null
    progress.value = null
    error.value = null
    selectedJudgmentId.value = null
    phase.value = 'loading'
    polling = true

    await runRound(qid, my)
  }

  /** POST 重试；成功后恢复轮询 */
  async function retry(qid: string): Promise<void> {
    cancelPolling()
    const my = generation
    currentQid = qid
    rounds = 0
    netErrors = 0
    error.value = null
    phase.value = 'loading'
    polling = true

    try {
      const res = await retryAnalysis(qid)
      if (my !== generation) return
      progress.value = res
      if (res.status === 'failed') {
        toFailed(res.error ?? makeError('llm_error'))
        return
      }
      phase.value = 'generating'
      scheduleNext(qid, my)
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
    load,
    retry,
    select,
    reset,
    cancelPolling,
  }
})
