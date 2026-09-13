import { PipelineError, type PipelineContext } from './agents/types'
import type { Stage } from '@two-sides/contract'
import { log } from './log'

export type PipelinePhase = 'fetchAnswers' | 'extract' | 'merge' | 'orient' | 'summary' | 'discoverTopics' | 'classifyAnswers'

// At the default 180s job limit, protect the necessary downstream stages.
// Shorter configured jobs scale reserves proportionally; caps remain upper bounds.
export const PHASE_BUDGETS = {
  fetchAnswers: { capMs: 45_000, reserveMs: 110_000 },
  extract: { capMs: 60_000, reserveMs: 75_000 },
  merge: { capMs: 75_000, reserveMs: 40_000 },
  orient: { capMs: 45_000, reserveMs: 2_000 },
  summary: { capMs: 12_000, reserveMs: 1_000 },
  discoverTopics: { capMs: 30_000, reserveMs: 31_000 },
  classifyAnswers: { capMs: 30_000, reserveMs: 1_000 },
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
