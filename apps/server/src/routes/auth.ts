/**
 * 知乎 OAuth 增强层。
 *
 * Access tokens are deliberately kept only in this process.  The browser gets
 * an opaque, HttpOnly session id; neither token nor authorization code is ever
 * returned or written to logs.
 */

import { Hono } from 'hono'
import type { Context } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { env } from '../env'
import { errFields, log } from '../log'
import { failResp, okData } from '../http'
import { forgetSignals } from '../user-signals'

const SESSION_COOKIE = 'two_sides_zhihu_session'
const STATE_COOKIE = 'two_sides_zhihu_state'
const SESSION_TTL_SEC = 60 * 60
const STATE_TTL_MS = 10 * 60 * 1000

type Session = { accessToken: string; expiresAt: number }

const sessions = new Map<string, Session>()
const pendingStates = new Map<string, number>()

function configured(): boolean {
  return Boolean(env.ZHIHU_OAUTH_APP_ID && env.ZHIHU_OAUTH_APP_KEY && env.ZHIHU_OAUTH_REDIRECT_URI)
}

function randomOpaque(): string {
  return crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '')
}

function prune(): void {
  const now = Date.now()
  for (const [id, session] of sessions) {
    if (session.expiresAt <= now) {
      sessions.delete(id)
      forgetSignals(id) // 会话过期 → 用户信号缓存一并释放，别留着占内存
    }
  }
  for (const [state, createdAt] of pendingStates) {
    if (createdAt + STATE_TTL_MS <= now) pendingStates.delete(state)
  }
}

/**
 * 取当前请求所属会话的 OAuth token（增强层其他功能共用）。
 * 未登录 / 会话过期返回 null —— 调用方一律降级处理，不报错。
 * 返回值只在服务端内存之间传递，绝不进日志、响应或数据库。
 */
export function sessionToken(c: Context): { sessionId: string; accessToken: string } | null {
  prune()
  const sessionId = getCookie(c, SESSION_COOKIE)
  if (!sessionId) return null
  const session = sessions.get(sessionId)
  if (!session || session.expiresAt <= Date.now()) return null
  return { sessionId, accessToken: session.accessToken }
}

function callbackRedirect(c: Context, ok: boolean): Response {
  return c.redirect(ok ? '/?oauth=success' : '/?oauth=error', 302)
}

export async function handleZhihuCallback(c: Context): Promise<Response> {
  prune()
  const url = new URL(c.req.url)
  const error = url.searchParams.get('error')
  if (error) return callbackRedirect(c, false)

  const returnedState = url.searchParams.get('state')
  if (returnedState) {
    const createdAt = pendingStates.get(returnedState)
    pendingStates.delete(returnedState)
    const cookieState = getCookie(c, STATE_COOKIE)
    if (!createdAt || createdAt + STATE_TTL_MS <= Date.now() || cookieState !== returnedState) {
      return failResp(c, 400, 'OAuth state 无效或已过期')
    }
    setCookie(c, STATE_COOKIE, '', { httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: 0 })
  }

  const code = url.searchParams.get('authorization_code') || url.searchParams.get('code')
  if (!code) return failResp(c, 400, '回调缺少 authorization_code')
  if (!configured()) return failResp(c, 503, 'OAuth 尚未配置')

  let response: Response
  try {
    const body = new URLSearchParams({
      app_id: env.ZHIHU_OAUTH_APP_ID,
      app_key: env.ZHIHU_OAUTH_APP_KEY,
      grant_type: 'authorization_code',
      redirect_uri: env.ZHIHU_OAUTH_REDIRECT_URI,
      code,
    })
    response = await fetch('https://openapi.zhihu.com/access_token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    })
  } catch (cause) {
    log.warn('oauth.token_exchange_failed', errFields(cause))
    return failResp(c, 502, '知乎 OAuth 暂时不可用')
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch (cause) {
    log.warn('oauth.token_response_invalid', { status: response.status, ...errFields(cause) })
    return failResp(c, 502, '知乎 OAuth 返回无效响应')
  }

  const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
  const accessToken = typeof record.access_token === 'string' ? record.access_token : ''
  if (!accessToken) {
    log.warn('oauth.token_exchange_rejected', { status: response.status })
    return failResp(c, 502, '知乎 OAuth 授权失败')
  }

  const expiresIn = typeof record.expires_in === 'number' && Number.isFinite(record.expires_in)
    ? Math.max(60, Math.floor(record.expires_in))
    : SESSION_TTL_SEC
  const sessionId = randomOpaque()
  const expiresAt = Date.now() + expiresIn * 1000
  sessions.set(sessionId, { accessToken, expiresAt })
  setCookie(c, SESSION_COOKIE, sessionId, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: expiresIn,
  })
  return callbackRedirect(c, true)
}

export const authRoutes = new Hono()

authRoutes.get('/auth/zhihu/status', (c) => {
  prune()
  const sessionId = getCookie(c, SESSION_COOKIE)
  const session = sessionId ? sessions.get(sessionId) : undefined
  const authorized = Boolean(session && session.expiresAt > Date.now())
  return okData(c, 200, {
    configured: configured(),
    callbackConfigured: Boolean(env.ZHIHU_OAUTH_REDIRECT_URI),
    appId: env.ZHIHU_OAUTH_APP_ID || null,
    redirectUri: env.ZHIHU_OAUTH_REDIRECT_URI || null,
    authorized,
    expiresAt: authorized ? session?.expiresAt : null,
  })
})

authRoutes.get('/auth/zhihu/authorize', (c) => {
  if (!configured()) return failResp(c, 503, 'OAuth 尚未配置')
  const state = randomOpaque()
  pendingStates.set(state, Date.now())
  setCookie(c, STATE_COOKIE, state, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: Math.floor(STATE_TTL_MS / 1000),
  })
  const target = new URL('https://openapi.zhihu.com/authorize')
  target.searchParams.set('redirect_uri', env.ZHIHU_OAUTH_REDIRECT_URI)
  target.searchParams.set('app_id', env.ZHIHU_OAUTH_APP_ID)
  target.searchParams.set('response_type', 'code')
  target.searchParams.set('state', state)
  return c.redirect(target.toString(), 302)
})

authRoutes.get('/auth/zhihu/callback', handleZhihuCallback)

authRoutes.post('/auth/zhihu/logout', (c) => {
  const sessionId = getCookie(c, SESSION_COOKIE)
  if (sessionId) {
    sessions.delete(sessionId)
    forgetSignals(sessionId)
  }
  setCookie(c, SESSION_COOKIE, '', {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: 0,
  })
  return okData(c, 200, { ok: true })
})

/** Public callback alias used by the deployed callback URL. */
export const publicCallbackRoutes = new Hono()
publicCallbackRoutes.get('/', handleZhihuCallback)
