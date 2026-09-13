/**
 * 增强层 · 「与你有关」（契约 §4.6 / ENDPOINTS.meRelated）
 *
 * GET /api/v1/me/related      当日热榜题里，你收藏过的问题 / 收藏过回答的那些
 * GET /api/v1/me/related?qid= 额外把某个带外打开的问题一起判定
 *
 * 语义（用户 2026-09-13 拍板）：
 *   开放平台**没有「关注问题」接口**，所以不做「你关注了这道题」。
 *   只承认两种 id 级精确匹配：收藏过这道题、收藏过这题里被写进光谱的回答。
 *
 * 未登录 → 200 + `{authorized:false, items:[]}`（有意不用 403，见契约注释）；
 * 取收藏失败 → 200 + `{authorized:true, degraded:true, items:[]}`，
 * 宁可少点亮，也不输出任何「无关」的否定断言。
 */

import { Hono } from 'hono'
import { RelatedResp } from '@two-sides/contract'
import { okData } from '../http'
import { log } from '../log'
import { sessionToken } from './auth'
import { relatedForSession } from '../user-signals'

export const meRoutes = new Hono()

const QID_RE = /^\d{1,20}$/

meRoutes.get('/me/related', async (c) => {
  const rawQid = (c.req.query('qid') ?? '').trim()
  const extraQid = QID_RE.test(rawQid) ? rawQid : undefined

  const session = sessionToken(c)
  if (!session) {
    // 未登录是正常态：前端安静降级，不渲染任何标记，也不报错
    log.debug('me.related.anonymous')
    return okData(c, 200, RelatedResp.parse({ authorized: false, items: [] }))
  }

  const result = await relatedForSession(session.sessionId, session.accessToken, extraQid)
  log.info('me.related.served', {
    items: result.items.length,
    degraded: result.degraded ?? false,
    reasons: result.items.map((i) => i.reasons.join('+')).join(','),
  })
  return okData(c, 200, RelatedResp.parse(result))
})
