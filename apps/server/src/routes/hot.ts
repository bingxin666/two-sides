/**
 * GET /api/v1/hot
 *
 * docs/03 §5.3：当日热榜，只含已 ready 的预置题（30 条，前端裁 24）；
 * 当日无数据 → 404。
 */

import { Hono } from 'hono'
import { HotResp } from '@two-sides/contract'
import { okData, failResp } from '../http'
import { log } from '../log'
import { listReadyHot } from '../repo'
import { todayKey } from '../time'

export const hotRoutes = new Hono()

hotRoutes.get('/hot', (c) => {
  const date = todayKey()
  const items = listReadyHot(date)
  if (items.length === 0) {
    return failResp(c, 404, '当日热榜尚未生成')
  }
  const payload = HotResp.parse({ date, items })
  log.info('hot.served', { date, count: items.length })
  return okData(c, 200, payload)
})
