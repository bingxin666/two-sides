/**
 * GET /api/v1/health
 *
 * docs/03 §5.3：额度来自知乎 /api/v1/quota（查询本身不消耗额度）。
 * 知乎不可达 / 未放行真实调用时：降级 ok:true + quota 三项为 null（额度未知），
 * 绝不因为查额度失败把健康检查拖挂，也不用 0/-1 谎报额度。
 */

import { Hono } from 'hono'
import { HealthEnvelope, type HealthResp } from '@two-sides/contract'
import { okData } from '../http'
import { log } from '../log'
import { todayKey } from '../time'
import { quota } from '../zhihu/client'

export const healthRoutes = new Hono()

healthRoutes.get('/health', async (c) => {
  const date = todayKey()
  const q = await quota()

  // 降级：null = 额度未知（契约 QuotaResp 三字段均 nullable）
  const quotaResp = q ?? { zhihu_search: null, hot_list: null, zhida_openai: null }

  const payload: HealthResp = { ok: true as const, date, quota: quotaResp }

  // 无论是否降级都过一次 schema：契约已允许 null，两端都该被校验拦住
  const parsed = HealthEnvelope.safeParse({ code: 0, data: payload })
  if (!parsed.success) {
    log.warn('health.schemaViolation', { issue: parsed.error.issues[0]?.message ?? 'unknown' })
  }

  return okData(c, 200, payload)
})
