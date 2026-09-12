import {
  Analysis,
  ENDPOINTS,
  HealthResp,
  HotResp,
  ProgressResp,
  SearchResp,
  type AnalysisResp,
  type HealthResp as HealthRespT,
  type HotResp as HotRespT,
  type ProgressResp as ProgressRespT,
  type SearchResp as SearchRespT,
} from '@two-sides/contract'

import { mockApi } from '@/mock/adapter'
import { passThrough, request, type RequestOptions } from './http'

/**
 * API 层（增强层 getOpposite 今天不做）。
 * 所有 URL 一律由 contract 的 ENDPOINTS 构造，不手写字符串。
 *
 * live 模式为产品缺省（真实后端）；mock（VITE_API_MODE=mock，需手动开）
 * 保留作离线应急 —— fixtures 与适配器留在仓库，调用方零改动。
 */

export const IS_MOCK = (import.meta.env.VITE_API_MODE ?? 'live') === 'mock'

/** 当日热榜（只含已 ready 的预置题） */
export async function getHot(): Promise<HotRespT> {
  if (IS_MOCK) return mockApi.getHot()
  const { data } = await request(ENDPOINTS.hot, HotResp)
  return data
}

/** 文字搜题：冷题入口（知乎对纯 qid 搜索不出结果），服务端去重后 ≤8 条 */
export async function getSearch(q: string): Promise<SearchRespT> {
  if (IS_MOCK) return mockApi.getSearch(q)
  const { data } = await request(ENDPOINTS.search(q), SearchResp)
  return data
}

/**
 * 唯一主端点。
 * 200 → 完整快照（AnalysisResp）；202 → 进度或失败（ProgressResp）。
 * 用响应形态而非状态码兜底，避免反向代理改写状态码时判错。
 * title：冷题懒生成的标题提示（来自 /search 候选或上游跳转），只进 query。
 */
export async function getAnalysis(
  qid: string,
  options?: RequestOptions & { title?: string },
): Promise<AnalysisResp | ProgressRespT> {
  if (IS_MOCK) return mockApi.getAnalysis(qid, options?.title)

  // 懒生成首响应可能要 12s+（后端 PIPELINE_FAKE_DURATION_MS），单次超时放宽到 30s；
  // hot/search/health 没有生成交互，维持 http.ts 的默认 12s
  const { title, ...rest } = options ?? {}
  const { status, data } = await request(ENDPOINTS.analysis(qid, title), passThrough, {
    ...rest,
    timeoutMs: options?.timeoutMs ?? 30_000,
  })
  const isSnapshot =
    status === 200 ||
    (typeof data === 'object' &&
      data !== null &&
      Array.isArray((data as Record<string, unknown>).judgments))

  return isSnapshot ? Analysis.parse(data) : ProgressResp.parse(data)
}

/** 失败重试 / ?force=1 强制重跑；返回当前进度体 */
export async function retryAnalysis(
  qid: string,
  force = false,
  title?: string,
): Promise<ProgressRespT> {
  if (IS_MOCK) return mockApi.retryAnalysis(qid, force, title)
  const { data } = await request(ENDPOINTS.retry(qid, force, title), ProgressResp, { method: 'POST' })
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
  getSearch,
  getAnalysis,
  retryAnalysis,
  getHealth,
}
