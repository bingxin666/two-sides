/** OpenAI-compatible client. One deadline covers capacity waits, body reads,
 * validation and every retry. Upstream bodies/errors never enter diagnostics. */
import { llmBucket, TokenWaitError } from '../ratelimit'
import { log } from '../log'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface CallContext {
  qid?: string
  date?: string
  stage?: string
  unit?: string
}

export interface ChatRequest {
  baseUrl: string
  apiKey: string
  model: string
  messages: ChatMessage[]
  jsonMode?: boolean
  temperature?: number
  maxTokens?: number
  /** OpenAI-compatible reasoning effort for reasoning models. */
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh'
  /** Supported by DeepSeek; independent from OpenAI reasoning_effort. */
  thinking?: 'enabled' | 'disabled'
  /** Per-attempt limit; deadlineAt is the shared total limit. */
  timeoutMs?: number
  deadlineAt?: number
  maxAttempts?: number
  context?: CallContext
  signal?: AbortSignal
  validate?: (raw: string) => unknown | Promise<unknown>
}

export interface TokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export interface LlmStats {
  latencyMs: number
  attempts: number
  rateLimitWaitMs: number
  usage?: TokenUsage
}

export interface ChatResult<T = string> extends LlmStats {
  content: T
  raw: string
  model: string
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly kind: 'config' | 'http' | 'network' | 'timeout' | 'parse' | 'aborted',
    readonly status?: number,
    readonly stats: LlmStats = { latencyMs: 0, attempts: 0, rateLimitWaitMs: 0 },
  ) {
    super(message)
    this.name = 'LlmError'
  }
}

export const DEFAULT_TIMEOUT_MS = 60_000
export const DEFAULT_MAX_ATTEMPTS = 3
export const llmCounters = { calls: 0, parseFailures: 0, tokens: 0 }

export function attemptLimit(value?: number): number {
  return value !== undefined && Number.isFinite(value)
    ? Math.max(1, Math.floor(value))
    : DEFAULT_MAX_ATTEMPTS
}

export function attemptTimeout(value?: number): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(1, value) : DEFAULT_TIMEOUT_MS
}

export function addUsage(a?: TokenUsage, b?: TokenUsage): TokenUsage | undefined {
  if (!a && !b) return undefined
  return {
    promptTokens: (a?.promptTokens ?? 0) + (b?.promptTokens ?? 0),
    completionTokens: (a?.completionTokens ?? 0) + (b?.completionTokens ?? 0),
    totalTokens: (a?.totalTokens ?? 0) + (b?.totalTokens ?? 0),
  }
}

export function assertCallActive(signal: AbortSignal | undefined, deadlineAt: number): void {
  if (signal?.aborted) throw new LlmError('llm call aborted', 'aborted')
  if (Date.now() >= deadlineAt) throw new LlmError('llm total deadline exceeded', 'timeout')
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500
}

/** Race even non-cooperative body readers/validators against cancellation. */
function abortable<T>(operation: () => T | PromiseLike<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      reject(new LlmError('llm attempt interrupted', 'aborted'))
    }
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve().then(() => {
      if (signal.aborted) throw new LlmError('llm attempt interrupted', 'aborted')
      return operation()
    }).then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

async function backoff(attempt: number, deadlineAt: number, signal?: AbortSignal): Promise<void> {
  assertCallActive(signal, deadlineAt)
  const waitMs = Math.min(500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250), deadlineAt - Date.now())
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(new LlmError('llm call aborted', 'aborted'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, Math.min(waitMs, 2_147_483_647))
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
  assertCallActive(signal, deadlineAt)
}

interface ChoicePayload {
  choices?: Array<{ message?: { content?: unknown }; text?: unknown; finish_reason?: string }>
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
}

function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function readUsage(payload: ChoicePayload): TokenUsage | undefined {
  if (!payload.usage || typeof payload.usage !== 'object') return undefined
  const promptTokens = tokenCount(payload.usage.prompt_tokens)
  const completionTokens = tokenCount(payload.usage.completion_tokens)
  return {
    promptTokens,
    completionTokens,
    totalTokens: payload.usage.total_tokens === undefined
      ? promptTokens + completionTokens : tokenCount(payload.usage.total_tokens),
  }
}

export async function chat<T = string>(req: ChatRequest): Promise<ChatResult<T>> {
  const started = performance.now()
  const maxAttempts = attemptLimit(req.maxAttempts)
  const timeoutMs = attemptTimeout(req.timeoutMs)
  const deadlineAt = req.deadlineAt ?? Date.now() + timeoutMs * maxAttempts
  let attempts = 0
  let rateLimitWaitMs = 0
  let usage: TokenUsage | undefined
  const stats = (): LlmStats => ({ latencyMs: Math.round(performance.now() - started), attempts, rateLimitWaitMs, usage })
  try {
    assertCallActive(req.signal, deadlineAt)
    if (!Number.isFinite(deadlineAt)) throw new LlmError('llm deadline must be finite', 'config')
    if (!req.apiKey) throw new LlmError('provider api key not configured', 'config')
    if (!req.baseUrl) throw new LlmError('provider baseUrl missing', 'config')
    const endpoint = `${req.baseUrl.replace(/\/+$/, '')}/chat/completions`
    let lastErr = new LlmError('llm call failed', 'network')

    while (attempts < maxAttempts) {
      assertCallActive(req.signal, deadlineAt)
      const waitStarted = performance.now()
      try {
        await llmBucket.take(1, { signal: req.signal, deadlineAt })
      } catch (e) {
        if (e instanceof TokenWaitError) throw new LlmError(e.message, e.kind)
        throw e
      } finally {
        rateLimitWaitMs += Math.round(performance.now() - waitStarted)
      }
      assertCallActive(req.signal, deadlineAt)
      const controller = new AbortController()
      const onOuterAbort = () => controller.abort()
      req.signal?.addEventListener('abort', onOuterAbort, { once: true })
      let timedOut = false
      const attemptDeadlineAt = Math.min(deadlineAt, Date.now() + timeoutMs)
      const timer = setTimeout(() => { timedOut = true; controller.abort() },
        Math.min(attemptDeadlineAt - Date.now(), 2_147_483_647))
      if (req.signal?.aborted) controller.abort()
      try {
        const body: Record<string, unknown> = { model: req.model, messages: req.messages }
        if (req.jsonMode) body.response_format = { type: 'json_object' }
        if (typeof req.temperature === 'number') body.temperature = req.temperature
        if (typeof req.maxTokens === 'number') body.max_tokens = req.maxTokens
        if (req.reasoningEffort) body.reasoning_effort = req.reasoningEffort
        if (req.thinking) body.thinking = { type: req.thinking }
        const encodedBody = JSON.stringify(body)
        const res = await abortable(() => {
          assertCallActive(req.signal, attemptDeadlineAt)
          attempts++
          llmCounters.calls++
          return fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${req.apiKey}` },
            body: encodedBody,
            signal: controller.signal,
          })
        }, controller.signal)
        if (!res.ok) {
          // Do not read or retain upstream error bodies: they can contain credentials.
          void res.body?.cancel().catch(() => {})
          throw new LlmError(`llm http ${res.status}`, 'http', res.status)
        }
        let payload: ChoicePayload
        try {
          payload = await abortable(() => res.json(), controller.signal) as ChoicePayload
        } catch (e) {
          if (controller.signal.aborted) throw e
          throw new LlmError('llm response is not valid JSON', 'parse')
        }
        if (!payload || typeof payload !== 'object') throw new LlmError('llm response is not an object', 'parse')
        // Count usage before validation: malformed model content was still billed.
        const billed = readUsage(payload)
        usage = addUsage(usage, billed)
        if (billed) llmCounters.tokens += billed.totalTokens
        assertCallActive(req.signal, attemptDeadlineAt)
        if (payload.choices?.[0]?.finish_reason === 'length') {
          log.warn('llm.output.truncated', { ...req.context, model: req.model, maxTokens: req.maxTokens })
          throw new LlmError('llm output exceeded token limit', 'parse')
        }
        const raw = extractContent(payload)
        if (raw === null) throw new LlmError('llm response has no content', 'parse')
        let content: unknown = raw
        if (req.validate) {
          try {
            content = await abortable(() => req.validate!(raw), controller.signal)
          } catch (e) {
            if (controller.signal.aborted) throw e
            throw new LlmError('llm output failed validation', 'parse')
          }
        }
        assertCallActive(req.signal, deadlineAt)
        if (controller.signal.aborted || timedOut || Date.now() >= attemptDeadlineAt) throw new LlmError('llm attempt timed out', 'timeout')
        return { content: content as T, raw, model: req.model, ...stats() }
      } catch (e) {
        assertCallActive(req.signal, deadlineAt)
        lastErr = timedOut || Date.now() >= attemptDeadlineAt ? new LlmError('llm attempt timed out', 'timeout')
          : e instanceof LlmError ? e : new LlmError('llm network request failed', 'network')
        if (lastErr.kind === 'parse') llmCounters.parseFailures++
        if (lastErr.kind === 'aborted' || lastErr.kind === 'config' ||
          (lastErr.kind === 'http' && !isRetryableStatus(lastErr.status ?? 0))) throw lastErr
      } finally {
        clearTimeout(timer)
        // Also release transport/body work after synchronous validation overruns
        // its deadline (the timer could not run while JavaScript was blocked).
        controller.abort()
        req.signal?.removeEventListener('abort', onOuterAbort)
      }
      if (attempts < maxAttempts) await backoff(attempts, deadlineAt, req.signal)
    }
    throw lastErr
  } catch (e) {
    const error = e instanceof LlmError ? e : new LlmError('llm request failed', 'network')
    const cumulative = stats()
    log.warn('llm.exhausted', { ...req.context, model: req.model, kind: error.kind, status: error.status, ...cumulative,
      tokens: cumulative.usage?.totalTokens ?? 0 })
    throw new LlmError(error.message, error.kind, error.status, cumulative)
  }
}

function extractContent(p: ChoicePayload): string | null {
  const c = p.choices?.[0]
  const content = c?.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const joined = content.map((part) => typeof part === 'string' ? part
      : typeof part?.text === 'string' ? part.text : '').join('')
    return joined || null
  }
  return typeof c?.text === 'string' ? c.text : null
}

/** Strip occasional Markdown JSON fences. */
export function parseJsonLoose(raw: string): unknown {
  const trimmed = raw.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed)
  const body = fenced?.[1] ?? trimmed
  const start = body.search(/[[{]/)
  return JSON.parse(start > 0 ? body.slice(start) : body)
}
