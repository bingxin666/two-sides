import {
  Analysis,
  ENDPOINTS,
  HealthResp,
  HotResp,
  ProgressResp,
  type AnalysisResp,
  type HealthResp as HealthRespT,
  type HotResp as HotRespT,
  type ProgressResp as ProgressRespT,
} from '@two-sides/contract'

import { mockApi } from '@/mock/adapter'
import { passThrough, request, type RequestOptions } from './http'

/**
 * API 层 —— 四个方法（增强层 getOpposite 今天不做）。
 * 所有 URL 一律由 contract 的 ENDPOINTS 构造，不手写字符串。
 *
 * mock 模式（VITE_API_MODE=mock，缺省也是 mock）直接返回 fixture，
 * 不经过 fetch；切到 live 只需换环境变量，调用方零改动。
 */

export const IS_MOCK = (import.meta.env.VITE_API_MODE ?? 'mock') === 'mock'

/** 当日热榜（只含已 ready 的预置题） */
export async function getHot(): Promise<HotRespT> {
  if (IS_MOCK) return mockApi.getHot()
  const { data } = await request(ENDPOINTS.hot, HotResp)
  return data
}

/**
 * 唯一主端点。
 * 200 → 完整快照（AnalysisResp）；202 → 进度或失败（ProgressResp）。
 * 用响应形态而非状态码兜底，避免反向代理改写状态码时判错。
 */
export async function getAnalysis(
  qid: string,
  options?: RequestOptions,
): Promise<AnalysisResp | ProgressRespT> {
  if (IS_MOCK) return mockApi.getAnalysis(qid)

  const { status, data } = await request(ENDPOINTS.analysis(qid), passThrough, options)
  const isSnapshot =
    status === 200 ||
    (typeof data === 'object' &&
      data !== null &&
      Array.isArray((data as Record<string, unknown>).judgments))

  return isSnapshot ? Analysis.parse(data) : ProgressResp.parse(data)
}

/** 失败重试 / ?force=1 强制重跑；返回当前进度体 */
export async function retryAnalysis(qid: string, force = false): Promise<ProgressRespT> {
  if (IS_MOCK) return mockApi.retryAnalysis(qid, force)
  const { data } = await request(ENDPOINTS.retry(qid, force), ProgressResp, { method: 'POST' })
  return data
}

/** 健康检查与额度（查询本身不消耗额度） */
export async function getHealth(): Promise<HealthRespT> {
  if (IS_MOCK) return mockApi.getHealth()
  const { data } = await request(ENDPOINTS.health, HealthResp)
  return data
}

// TODO(增强层): getOpposite(judgmentId) —— OAuth 授权后的「光谱另一侧」推荐，
// 走 ENDPOINTS.meOpposite，未授权返回 403。等活动页 App ID / App Key 批下来再做。

export const api = {
  getHot,
  getAnalysis,
  retryAnalysis,
  getHealth,
}
