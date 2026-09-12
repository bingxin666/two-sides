/**
 * 知乎直答客户端（docs/03 §8.2 直答行、§8.1 鉴权）
 *
 * 与开放平台同一把凭证（ZHIHU_ACCESS_SECRET 做 Bearer），但模型档位与字段约束独立：
 *  - POST https://developer.zhihu.com/v1/chat/completions
 *  - 仅 model / messages / stream 三字段受支持 —— response_format 不在支持字段内，
 *    结构化输出不可用，靠 prompt 约束输出形态
 *  - X-Request-Timestamp 必须秒级
 *  - Access Secret 不发送到其他主机（BASE 与开放平台同域）
 *
 * 综述专用，永不挪用（docs/01 §2）。额度 100/日是最紧资源：
 * 30002 → quota_exhausted → 调用方（agents/llm.ts summarize）降级外部 LLM 并打日志。
 */

import { env } from '../env'
import { errFields, log } from '../log'
import { unixSeconds } from '../time'
import type { ChatMessage } from './client'

const BASE = 'https://developer.zhihu.com'

const ALLOWED_MODELS = new Set(['zhida-fast-1p5', 'zhida-thinking-1p5', 'zhida-agent'])

export class ZhidaError extends Error {
  constructor(
    message: string,
    readonly kind: 'quota' | 'auth' | 'http' | 'network' | 'parse' | 'aborted',
    readonly retryable: boolean,
    readonly zhihuCode?: number,
  ) {
    super(message)
    this.name = 'ZhidaError'
  }
}

export interface ZhidaResult {
  content: string
  model: string
  latencyMs: number
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number }
}

/** 直答调用计数（诊断/额度观测用，进程内累计，不含任何凭证信息） */
export const zhidaCounters = { calls: 0, degraded: 0, tokens: 0 }

export function zhidaModel(): string {
  const m = env.ZHIHU_ZHIDA_MODEL
  if (!ALLOWED_MODELS.has(m)) {
    log.warn('zhida.modelFallback', { configured: m, using: 'zhida-thinking-1p5' })
    return 'zhida-thinking-1p5'
  }
  return m
}

interface ChoicePayload {
  choices?: Array<{ message?: { content?: unknown } }>
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
  Code?: number
  Message?: string
}

/**
 * 直答综述调用（非流式、纯文本取回）。
 * 超时 30s；不重试 —— 额度是最紧资源，重试会放大消耗，降级交给调用方。
 */
export async function zhidaChat(
  messages: ChatMessage[],
  opts: { signal?: AbortSignal; maxTokens?: number } = {},
): Promise<ZhidaResult> {
  const secret = process.env.ZHIHU_ACCESS_SECRET
  if (!secret) throw new ZhidaError('ZHIHU_ACCESS_SECRET not configured', 'auth', false)
  const model = zhidaModel()

  const started = performance.now()
  zhidaCounters.calls++

  const controller = new AbortController()
  const onAbort = () => controller.abort()
  opts.signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), 30_000)

  try {
    // 只发 model / messages / stream 三个受支持字段；多余字段「不保证生效」
    const body: Record<string, unknown> = { model, messages, stream: false }
    if (typeof opts.maxTokens === 'number') body.max_tokens = opts.maxTokens

    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${secret}`,
        'X-Request-Timestamp': String(unixSeconds()),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    const latencyMs = Math.round(performance.now() - started)

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        throw new ZhidaError(`zhida auth rejected (http ${res.status})`, 'auth', false, 20001)
      }
      if (res.status === 429) {
        throw new ZhidaError('zhida rate limited', 'http', true, 30001)
      }
      throw new ZhidaError(`zhida http ${res.status}`, 'http', true)
    }

    const payload = (await res.json()) as ChoicePayload

    // HTTP 200 里可能藏业务错误（docs/03 §8.3）：必须判 Code
    const code = payload.Code
    if (typeof code === 'number' && code !== 0) {
      if (code === 30002) {
        // 配额耗尽 —— 不可重试，调用方降级外部 LLM
        throw new ZhidaError('zhida quota exhausted', 'quota', false, code)
      }
      if (code === 20001) {
        throw new ZhidaError('zhida auth rejected', 'auth', false, code)
      }
      throw new ZhidaError(`zhida business error (code=${code})`, 'http', true, code)
    }

    const c = payload.choices?.[0]?.message?.content
    const content = typeof c === 'string' ? c : null
    if (content === null || content.trim() === '') {
      throw new ZhidaError('zhida response has no content', 'parse', true)
    }

    const usage = payload.usage
      ? {
          promptTokens: payload.usage.prompt_tokens ?? 0,
          completionTokens: payload.usage.completion_tokens ?? 0,
          totalTokens:
            payload.usage.total_tokens ??
            (payload.usage.prompt_tokens ?? 0) + (payload.usage.completion_tokens ?? 0),
        }
      : undefined
    if (usage) zhidaCounters.tokens += usage.totalTokens

    log.info('zhida.call.ok', { model, latencyMs, tokens: usage?.totalTokens ?? 0 })
    return { content, model, latencyMs, usage }
  } catch (e) {
    if (e instanceof ZhidaError) throw e
    if (isAbortError(e)) throw new ZhidaError('aborted', 'aborted', true)
    log.warn('zhida.call.fail', errFields(e))
    throw new ZhidaError(`zhida network error: ${String(e).slice(0, 200)}`, 'network', true)
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onAbort)
  }
}

function isAbortError(e: unknown): boolean {
  return (
    e instanceof DOMException ||
    (typeof e === 'object' && e !== null && (e as { name?: string }).name === 'AbortError')
  )
}
