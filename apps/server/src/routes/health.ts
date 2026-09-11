/**
 * GET /api/v1/health
 *
 * docs/03 §5.3：额度来自知乎 /api/v1/quota（查询本身不消耗额度）。
 * 知乎不可达 / 未放行真实调用时：降级 ok:true + quota 全 -1，
 * 绝不因为查额度失败把健康检查拖挂。
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

  // 降级：未知额度用 -1 表示「未知」而不是谎报 0
  const quotaResp = q ?? { zhihu_search: -1, hot_list: -1, zhida_openai: -1 }

  const payload: HealthResp = { ok: true as const, date, quota: quotaResp }

  if (q) {
    // 契约要求 quota 非负；降级态的 -1 不进 schema 校验（否则整个 health 会失败）
    const parsed = HealthEnvelope.safeParse({ code: 200, data: payload })
    if (!parsed.success) {
      log.warn('health.schemaViolation', { issue: parsed.error.issues[0]?.message ?? 'unknown' })
    }
  }

  return okData(c, 200, payload)
})
