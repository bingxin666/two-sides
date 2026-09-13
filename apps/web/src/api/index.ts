import {
  Analysis,
  ENDPOINTS,
  HealthResp,
  HotResp,
  ProgressResp,
  RelatedResp,
  ZhihuAuthStatusResp,
  type AnalysisResp,
  type HealthResp as HealthRespT,
  type HotResp as HotRespT,
  type ProgressResp as ProgressRespT,
  type RelatedResp as RelatedRespT,
  type ZhihuAuthStatusResp as ZhihuAuthStatusT,
} from '@two-sides/contract'

import { mockApi } from '@/mock/adapter'
import { passThrough, request, type RequestOptions } from './http'

/**
 * API 层（增强层 getOpposite 今天不做）。
 * 所有 URL 一律由 contract 的 ENDPOINTS 构造，不手写字符串。
 *
 * 产品入口只有热榜（2026-09-13 收敛）：没有「输入问题文字」的搜索端点。
 *
 * live 模式为产品缺省（真实后端）；mock（VITE_API_MODE=mock，需手动开）
 * 保留作离线应急 —— fixtures 与适配器留在仓库，调用方零改动。
 */

const API_MODE = import.meta.env.VITE_API_MODE ?? 'live'
if (API_MODE !== 'live' && API_MODE !== 'mock') {
  throw new Error(`VITE_API_MODE 必须是 live 或 mock，当前值无效: ${API_MODE}`)
}
export const IS_MOCK = API_MODE === 'mock'

/** 当日热榜（只含已 ready 的预置题）——产品唯一入口 */
export async function getHot(): Promise<HotRespT> {
  if (IS_MOCK) return mockApi.getHot()
  const { data } = await request(ENDPOINTS.hot, HotResp)
  return data
}

/**
 * 唯一主端点。
 * 200 → 完整快照（AnalysisResp）；202 → 进度或失败（ProgressResp）。
 * 用响应形态而非状态码兜底，避免反向代理改写状态码时判错。
 * title：题名提示，正常路径由热榜预生成写入 question_titles 缓存，无需前端携带。
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

/**
 * 增强层 · 登录态（不产生任何知乎调用；只读服务端会话 cookie）
 */
export async function getZhihuStatus(): Promise<ZhihuAuthStatusT> {
  if (IS_MOCK) return mockApi.getZhihuStatus()
  const { data } = await request(ENDPOINTS.zhihuStatus, ZhihuAuthStatusResp)
  return data
}

/**
 * 增强层 · 当日热榜题里「与你有关」的那些（收藏过的题 / 收藏过的回答）。
 * 未登录时后端返回 authorized:false + 空 items（200，不是 403），前端安静降级。
 * qid 可选：问题页带外打开时额外判定它本身。
 */
export async function getRelated(qid?: string): Promise<RelatedRespT> {
  if (IS_MOCK) return mockApi.getRelated(qid)
  const { data } = await request(ENDPOINTS.meRelated(qid), RelatedResp)
  return data
}

/**
 * 增强层 · 退出登录（清服务端会话 + 本地信号缓存）
 */
export async function logoutZhihu(): Promise<void> {
  if (IS_MOCK) return
  await request(ENDPOINTS.zhihuLogout, passThrough, { method: 'POST' })
}

/** 知乎授权入口：整页跳转（后端 302 到知乎授权页） */
export function goZhihuAuthorize(): void {
  window.location.assign(ENDPOINTS.zhihuAuthorize)
}

// TODO(增强层): getOpposite(judgmentId) —— OAuth 授权后的「光谱另一侧」推荐，
// 走 ENDPOINTS.meOpposite，未授权返回 403。等活动页 App ID / App Key 批下来再做。

export const api = {
  getHot,
  getAnalysis,
  retryAnalysis,
  getHealth,
  getZhihuStatus,
  getRelated,
  logoutZhihu,
  goZhihuAuthorize,
}
