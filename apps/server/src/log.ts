/**
 * 结构化日志 + 凭证指纹
 *
 * 安全红线（docs/03 §11.5 / docs/04 §6）：
 *  - 日志绝不打印凭证本体、Authorization 头、用户 query、完整响应体
 *  - 必须报告凭证状态时，只输出「是否配置 + 长度 + SHA-256 短前缀」
 */

type Level = 'debug' | 'info' | 'warn' | 'error'

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }

const configured = (process.env.LOG_LEVEL ?? 'info').toLowerCase()
const threshold = LEVELS[(configured as Level) in LEVELS ? (configured as Level) : 'info']

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return
  const line: Record<string, unknown> = {
    t: new Date().toISOString(),
    level,
    msg,
  }
  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue
      // 哪怕调用方误传，也不能把可能的凭证字段写出去
      line[k] = sanitizeField(k, v, new WeakSet())
    }
  }
  const out = JSON.stringify(line)
  if (level === 'error') console.error(out)
  else if (level === 'warn') console.warn(out)
  else console.log(out)
}

const SECRET_KEY_RE =
  /(secret|token|apikey|api_key|authorization|password|cookie|credential|appkey|app_key)/i

function isSecretKey(key: string): boolean {
  return SECRET_KEY_RE.test(key)
}

// Exact metric names and finite numbers only. A string named "tokens" can be
// an actual credential and must keep the same redaction as every other secret.
const TOKEN_METRIC_KEYS = new Set([
  'tokens', 'promptTokens', 'completionTokens', 'totalTokens',
  'prompt_tokens', 'completion_tokens', 'total_tokens',
])

function sanitizeField(key: string, value: unknown, seen: WeakSet<object>): unknown {
  if (isSecretKey(key) && !(TOKEN_METRIC_KEYS.has(key) &&
    typeof value === 'number' && Number.isFinite(value) && value >= 0)) return '[redacted]'
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return '[circular]'
  seen.add(value)
  const out = Array.isArray(value)
    ? value.map((entry) => sanitizeField('', entry, seen))
    : Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitizeField(k, v, seen)]))
  seen.delete(value)
  return out
}

export const log = {
  debug: (msg: string, f?: Record<string, unknown>) => emit('debug', msg, f),
  info: (msg: string, f?: Record<string, unknown>) => emit('info', msg, f),
  warn: (msg: string, f?: Record<string, unknown>) => emit('warn', msg, f),
  error: (msg: string, f?: Record<string, unknown>) => emit('error', msg, f),
}

/**
 * 凭证指纹：只暴露「是否配置 + 长度 + SHA-256 短前缀」。
 * 用于启动自检与 /health 之外的诊断输出，绝不含原始值。
 */
export function secretFingerprint(value: string | undefined | null): {
  configured: boolean
  length: number
  sha256: string
} {
  if (!value) return { configured: false, length: 0, sha256: '' }
  let sha256 = ''
  try {
    const hasher = new Bun.CryptoHasher('sha256')
    hasher.update(value)
    sha256 = (hasher.digest('hex') as string).slice(0, 8)
  } catch {
    sha256 = 'n/a'
  }
  return { configured: true, length: value.length, sha256 }
}

/** 把任意错误收敛成可记录的对象，避免把 stack 里的敏感头信息带出去 */
export function errFields(e: unknown): Record<string, unknown> {
  if (e instanceof Error) {
    return { err: e.name, message: e.message.slice(0, 300) }
  }
  return { err: typeof e, message: String(e).slice(0, 300) }
}
