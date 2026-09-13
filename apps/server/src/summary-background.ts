/** Best-effort summaries never hold the primary analysis worker or its deadline. */
import type { Analysis } from '@two-sides/contract'
import type { OrientedJudgment, PipelineAgents, RawAnswer } from './agents/types'
import { log } from './log'
import { patchReadySummary, type JobRow, type ReadySummaryResult, type ReadySummaryVersion } from './repo'

export interface BackgroundSummaryInput {
  job: JobRow
  analysis: Analysis
  agents: Pick<PipelineAgents, 'summarize'>
  answers: RawAnswer[]
  judgments: OrientedJudgment[]
}

interface QueuedSummary {
  input: BackgroundSummaryInput
  version: ReadySummaryVersion
  deadlineAt: number
  controller: AbortController
  timer: ReturnType<typeof setTimeout>
  state: 'queued' | 'running' | 'done'
}

export class BackgroundSummaryQueue {
  private readonly tasks = new Map<string, QueuedSummary>()
  private readonly waiting: QueuedSummary[] = []
  private running = 0
  private readonly idleWaiters = new Set<() => void>()

  constructor(private readonly options: { concurrency?: number; capacity?: number; timeoutMs?: number } = {}) {}

  get size(): number { return this.tasks.size }
  get active(): number { return this.running }

  /** Bounded retained inputs; each item gets its deadline at enqueue, not worker start. */
  enqueue(input: BackgroundSummaryInput): boolean {
    if (input.analysis.summaryStatus !== 'pending') return false
    const version = { jobId: input.job.id, date: input.job.date, qid: input.job.qid,
      attempts: input.job.attempts, data: JSON.stringify(input.analysis) }
    const key = `${version.jobId}:${version.attempts}`
    if (this.tasks.has(key)) return false
    const capacity = Math.max(1, this.options.capacity ?? 32)
    if (this.tasks.size >= capacity) {
      this.patch(version, undefined, 'queue_full')
      return false
    }
    const timeoutMs = Math.max(1, this.options.timeoutMs ?? 12_000)
    const task: QueuedSummary = { input, version, deadlineAt: Date.now() + timeoutMs,
      controller: new AbortController(), timer: undefined!, state: 'queued' }
    task.timer = setTimeout(() => this.finish(task, undefined, 'timeout'), timeoutMs)
    this.tasks.set(key, task)
    this.waiting.push(task)
    // Primary markReady/runJob cleanup completes before summary work starts.
    queueMicrotask(() => this.drain())
    return true
  }

  cancel(date: string, qid: string): void {
    for (const task of [...this.tasks.values()]) {
      if (task.version.date === date && task.version.qid === qid) this.finish(task, undefined, 'superseded')
    }
  }

  whenIdle(): Promise<void> {
    if (this.tasks.size === 0) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.add(resolve))
  }

  private drain(): void {
    const concurrency = Math.max(1, this.options.concurrency ?? 2)
    while (this.running < concurrency && this.waiting.length) {
      const task = this.waiting.shift()!
      if (task.state !== 'queued') continue
      if (Date.now() >= task.deadlineAt) { this.finish(task, undefined, 'timeout'); continue }
      task.state = 'running'
      this.running++
      void this.run(task)
    }
  }

  private async run(task: QueuedSummary): Promise<void> {
    const { input, version } = task
    try {
      const result = await input.agents.summarize(input.answers, input.judgments, {
        date: version.date, qid: version.qid, signal: task.controller.signal,
        deadlineAt: task.deadlineAt, report() {},
        note(event) { log.debug('summary.background.note', { date: version.date, qid: version.qid, event }) },
      })
      if (task.state === 'done') return
      if (task.controller.signal.aborted || Date.now() >= task.deadlineAt) {
        this.finish(task, undefined, 'timeout')
      } else if (!result.summary?.trim()) {
        this.finish(task, undefined, 'empty')
      } else {
        this.finish(task, { summary: result.summary.trim(), source: result.source ?? 'liukanshan' }, 'ready')
      }
    } catch {
      // Summarizer errors may include provider response content: never log them.
      this.finish(task, undefined, 'failed')
    }
  }

  private patch(version: ReadySummaryVersion, result: ReadySummaryResult | undefined, reason: string): void {
    try {
      const applied = patchReadySummary(version, result)
      log.info('summary.background.finished', { date: version.date, qid: version.qid,
        jobId: version.jobId, attempts: version.attempts, reason, applied })
    } catch {
      // A temporary write failure is repaired by the >60s stale-summary path.
      log.warn('summary.background.writeFailed', { date: version.date, qid: version.qid, jobId: version.jobId })
    }
  }

  private finish(task: QueuedSummary, result: ReadySummaryResult | undefined, reason: string): void {
    if (task.state === 'done') return
    if (task.state === 'running') this.running--
    task.state = 'done'
    clearTimeout(task.timer)
    task.controller.abort()
    this.tasks.delete(`${task.version.jobId}:${task.version.attempts}`)
    const index = this.waiting.indexOf(task)
    if (index >= 0) this.waiting.splice(index, 1)
    this.patch(task.version, result, reason)
    if (this.tasks.size === 0) {
      for (const resolve of this.idleWaiters) resolve()
      this.idleWaiters.clear()
    }
    queueMicrotask(() => this.drain())
  }
}

const backgroundSummaries = new BackgroundSummaryQueue()
export const enqueueBackgroundSummary = (input: BackgroundSummaryInput): boolean => backgroundSummaries.enqueue(input)
export const cancelBackgroundSummary = (date: string, qid: string): void => backgroundSummaries.cancel(date, qid)
