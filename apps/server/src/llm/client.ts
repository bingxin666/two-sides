/**
 * OpenAI 兼容 LLM 客户端（原生 fetch，不引重 SDK）
 *
 * docs/03 §3.1：
 *  - 强制 JSON：prompt 内嵌 schema + response_format json_object；不支持的服务商降级为「解析失败即重试」
 *  - 超时 60s/次；指数退避重试 2 次（429/5xx/网络/解析失败才重试，400 直接失败）
 *  - 每次调用先过全局令牌桶
 *  - 调用方给 validate（zod）做结构校验，本模块只负责把 content 交给它
 *
 * 安全：apiKey 只出现在 Authorization 头里，任何分支都不写入日志/错误对象。
 */

import { llmBucket } from '../ratelimit'
import { log } from '../log'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatRequest {
  baseUrl: string
  apiKey: string
  model: string
  messages: ChatMessage[]
  /** 是否要求 JSON 对象输出（不支持的服务商会忽略，退化为解析失败重试） */
  jsonMode?: boolean
  temperature?: number
  maxTokens?: number
  timeoutMs?: number
  signal?: AbortSignal
  /** 调用方提供的结构校验（zod）。失败按「解析失败」重试 */
  validate?: (raw: string) => unknown
}

export interface ChatResult<T = string> {
  content: T
  raw: string
  model: string
  latencyMs: number
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number }
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly kind: 'config' | 'http' | 'network' | 'timeout' | 'parse' | 'aborted',
    readonly status?: number,
  ) {
    super(message)
    this.name = 'LlmError'
  }
}

const DEFAULT_TIMEOUT_MS = 60_000
const MAX_ATTEMPTS = 3 // 首次 + 2 次重试

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500
}

/** 指数退避 + 抖动；abort 时立即跳出 */
async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve()
    const t = setTimeout(done, ms)
    const onAbort = () => {
      clearTimeout(t)
      done()
    }
    let finished = false
    function done() {
      if (finished) return
      finished = true
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

interface ChoicePayload {
  choices?: Array<{ message?: { content?: unknown }; text?: unknown }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

/**
 * 单次 /chat/completions 调用。
 * 成功返回解析后的 content；失败抛 LlmError。
 */
export async function chat<T = string>(req: ChatRequest): Promise<ChatResult<T>> {
  if (!req.apiKey) throw new LlmError('provider api key not configured', 'config')
  if (!req.baseUrl) throw new LlmError('provider baseUrl missing', 'config')

  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const endpoint = `${req.baseUrl.replace(/\/+$/, '')}/chat/completions`

  let lastErr: LlmError | null = null

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (req.signal?.aborted) throw new LlmError('aborted', 'aborted')

    // 全局令牌桶：管线共享，防打爆
    await llmBucket.take(1)

    const controller = new AbortController()
    const onOuterAbort = () => controller.abort()
    req.signal?.addEventListener('abort', onOuterAbort, { once: true })
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    const started = performance.now()
    try {
      const body: Record<string, unknown> = {
        model: req.model,
        messages: req.messages,
      }
      if (req.jsonMode) body.response_format = { type: 'json_object' }
      if (typeof req.temperature === 'number') body.temperature = req.temperature
      if (typeof req.maxTokens === 'number') body.max_tokens = req.maxTokens

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${req.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      const latencyMs = Math.round(performance.now() - started)

      if (!res.ok) {
        const detail = (await safeText(res)).slice(0, 200)
        const err = new LlmError(
          `llm http ${res.status}${detail ? `: ${detail}` : ''}`,
          'http',
          res.status,
        )
        if (!isRetryableStatus(res.status)) throw err
        lastErr = err
        await backoff(attempt, req.signal)
        continue
      }

      const payload = (await res.json()) as ChoicePayload
      const raw = extractContent(payload)
      if (raw === null) {
        lastErr = new LlmError('llm response has no content', 'parse')
        await backoff(attempt, req.signal)
        continue
      }

      let content: unknown = raw
      if (req.validate) {
        try {
          content = req.validate(raw)
        } catch (e) {
          lastErr = new LlmError(
            `llm output failed validation: ${e instanceof Error ? e.message : String(e)}`,
            'parse',
          )
          await backoff(attempt, req.signal)
          continue
        }
      }

      return {
        content: content as T,
        raw,
        model: req.model,
        latencyMs,
        usage: payload.usage
          ? {
              promptTokens: payload.usage.prompt_tokens ?? 0,
              completionTokens: payload.usage.completion_tokens ?? 0,
              totalTokens:
                payload.usage.total_tokens ??
                (payload.usage.prompt_tokens ?? 0) + (payload.usage.completion_tokens ?? 0),
            }
          : undefined,
      }
    } catch (e) {
      if (e instanceof LlmError) {
        if (e.kind === 'http' || e.kind === 'config') throw e
        lastErr = e
      } else if (isAbortError(e)) {
        // 外部 abort（job 超时 / 取消）不属于可重试失败，直接上抛
        throw new LlmError('aborted', 'aborted')
      } else {
        lastErr = new LlmError(`llm network error: ${String(e).slice(0, 200)}`, 'network')
      }
      await backoff(attempt, req.signal)
    } finally {
      clearTimeout(timer)
      req.signal?.removeEventListener('abort', onOuterAbort)
    }
  }

  log.warn('llm.exhausted', { model: req.model, attempts: MAX_ATTEMPTS })
  throw lastErr ?? new LlmError('llm call failed', 'network')
}

function backoff(attempt: number, signal?: AbortSignal): Promise<void> {
  if (attempt >= MAX_ATTEMPTS) return Promise.resolve()
  const base = 500 * 2 ** (attempt - 1)
  const jitter = Math.floor(Math.random() * 250)
  return sleep(base + jitter, signal)
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ''
  }
}

function extractContent(p: ChoicePayload): string | null {
  const c = p.choices?.[0]
  const content = c?.message?.content
  if (typeof content === 'string') return content
  // 极少数兼容层返回数组形式
  if (Array.isArray(content)) {
    const joined = content
      .map((part) => (typeof part === 'string' ? part : (part as { text?: string })?.text ?? ''))
      .join('')
    return joined || null
  }
  if (typeof c?.text === 'string') return c.text
  return null
}

function isAbortError(e: unknown): boolean {
  return (
    e instanceof DOMException ||
    (typeof e === 'object' && e !== null && (e as { name?: string }).name === 'AbortError')
  )
}
