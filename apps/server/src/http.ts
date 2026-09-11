/**
 * 统一信封（docs/03 §5）：成功 { code, data }；失败 { code, message }
 * code 取 HTTP 状态码，前端按它决定分支（200 快照 / 202 进度 / 4xx 5xx 失败）。
 */

import type { Context } from 'hono'

export type HttpStatus = 200 | 202 | 400 | 403 | 404 | 500

export function okData<T>(c: Context, status: 200 | 202, data: T): Response {
  return c.json({ code: status, data }, status)
}

export function failResp(c: Context, status: HttpStatus, message: string): Response {
  return c.json({ code: status, message }, status)
}
