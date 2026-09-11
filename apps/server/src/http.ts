/**
 * 统一信封（docs/03 §5）
 *
 * 语义（2026-09-12 team-lead 拍板，修复 P0 契约漂移）：
 *   成功 → { code: 0, data }，HTTP 状态码仍为 200 / 202
 *   失败 → { code: <非0>, message }，code 取 HTTP 状态码（404/500 等）
 *
 * 即：HTTP status 承载传输层语义；信封 code 只表示「业务成功/失败」，
 * 前端以 `code !== 0` 判错（apps/web/src/api/http.ts），所以成功必须是 0。
 */

import type { Context } from 'hono'

export type HttpStatus = 200 | 202 | 400 | 403 | 404 | 500

export function okData<T>(c: Context, status: 200 | 202, data: T): Response {
  return c.json({ code: 0, data }, status)
}

export function failResp(c: Context, status: HttpStatus, message: string): Response {
  return c.json({ code: status, message }, status)
}
