import { API_V1 } from '@two-sides/contract'

/**
 * 极薄的一层 fetch 封装。
 * 只做三件事：拼 baseURL、解 { code, data } 信封、把 HTTP/业务错误统一成 ApiError。
 * 不含任何鉴权与密钥 —— 前端永远碰不到密钥。
 */

export const API_BASE = (import.meta.env.VITE_API_BASE ?? API_V1).replace(/\/+$/, '')

/** 只接受 zod schema 的 parse 能力，避免 web 侧直接依赖 zod（它由 contract 包自带） */
export interface Schema<T> {
  parse(input: unknown): T
}

export const passThrough: Schema<unknown> = {
  parse: (input: unknown) => input,
}

/** 把契约里的端点路径（形如 /api/v1/hot）拼到配置的 base 上 */
export function resolveUrl(endpointPath: string): string {
  if (/^https?:\/\//i.test(endpointPath)) return endpointPath
  const rest = endpointPath.startsWith(API_V1) ? endpointPath.slice(API_V1.length) : endpointPath
  return `${API_BASE}${rest.startsWith('/') ? rest : `/${rest}`}`
}

export class ApiError extends Error {
  /** 业务错误码（信封里的 code）或 HTTP 状态码 */
  readonly code: number
  readonly status: number

  constructor(code: number, message: string, status = 0) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST'
  body?: unknown
  signal?: AbortSignal
  /** 单次请求超时（ms），默认 12s。轮询时会带 signal，两者取先到者 */
  timeoutMs?: number
  headers?: Record<string, string>
}

export interface RawResponse<T> {
  status: number
  data: T
}

function isEnvelope(value: unknown): value is { code: number; data?: unknown; message?: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    typeof (value as { code: unknown }).code === 'number'
  )
}

export async function request<T>(
  endpointPath: string,
  schema: Schema<T>,
  options: RequestOptions = {},
): Promise<RawResponse<T>> {
  const { method = 'GET', body, signal, timeoutMs = 12_000, headers } = options

  // 外部 signal 与超时合并：任一方 abort 都取消 fetch
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new DOMException('请求超时', 'TimeoutError')), timeoutMs)
  const relay = () => ctrl.abort(signal?.reason)
  if (signal) {
    if (signal.aborted) relay()
    else signal.addEventListener('abort', relay, { once: true })
  }

  let res: Response
  try {
    res = await fetch(resolveUrl(endpointPath), {
      method,
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    })
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', relay)
  }

  const text = await res.text()
  const json: unknown = text ? JSON.parse(text) : null

  let payload: unknown = json
  if (isEnvelope(json)) {
    // 成功：{ code, data }；失败：{ code, message }
    // 兼容两种信封约定：code === 0（最终统一形态），或 code 直接承载 HTTP 状态码
    // （过渡形态，2xx 视为成功）。404/5xx 一律失败，HTTP 200 里包业务错误也能拦住。
    const codeOk = json.code === 0 || (json.code >= 200 && json.code < 300)
    if (!codeOk) throw new ApiError(json.code, json.message ?? `接口返回错误 ${json.code}`, res.status)
    payload = json.data
  } else if (!res.ok) {
    throw new ApiError(res.status, `请求失败（HTTP ${res.status}）`, res.status)
  }

  return { status: res.status, data: schema.parse(payload) }
}
