/**
 * 知乎开放平台客户端（D1 已按真实 payload 收紧，docs/03 §8）
 *
 * 真实响应结构（2026-09-12 实测）：
 *   hot_list / zhihu_search → { Code, Message, Data: { Total?, HasMore?, SearchHashId?, Items: [...] } }
 *   hot_list 的 Item：{ Title, Url, ThumbnailUrl, Summary }
 *   zhihu_search 的 Item：{ Title, ContentType:"Answer", ContentID, ContentText, Url,
 *                           CommentCount, VoteUpCount, AuthorName, AuthorAvatar, AuthorBadge,
 *                           AuthorBadgeText, EditTime, AuthorityLevel, RankingScore }
 *
 * 踩坑点（docs/03 §8.3，已全部落实）：
 *   · AuthorityLevel 是 String（"1"–"4"），入库前转 number
 *   · AuthorBadge 是图片 URL，AuthorBadgeText 才是认证文案 —— 只用后者
 *   · Url 自带溯源 UTM，原样透传，不改写不去参
 *   · ContentText 长回答可能截断（实测 ~1000 字量级），喂模型时再截
 *   · HTTP 200 里可能藏业务错误（Code != 0），必须判 Code
 *   · 搜索结果只有 CommentCount，没有评论内容/CommentInfoList —— commentChallengeCount
 *     暂时无数据来源（见 agents/llm.ts，待与产品确认口径）
 *
 * 鉴权：Authorization: Bearer <ZHIHU_ACCESS_SECRET> + X-Request-Timestamp（秒级），
 * 基础域名 https://developer.zhihu.com，Access Secret 不发送到其他主机。
 *
 * D0 闸门：默认不发真实请求（ZHIHU_LIVE=1 且凭证已配置才放行）。
 */

import type { ErrorCode } from '@two-sides/contract'
import { env, zhihuSecretStatus } from '../env'
import { log } from '../log'
import { unixSeconds } from '../time'

const BASE = 'https://developer.zhihu.com'

export class ZhihuError extends Error {
  constructor(
    message: string,
    readonly errorCode: ErrorCode,
    readonly retryable: boolean,
    readonly zhihuCode?: number,
  ) {
    super(message)
    this.name = 'ZhihuError'
  }
}

/** 是否允许真实调用：显式开关 + 凭证已配置，两者缺一不可 */
export function isLive(): boolean {
  return env.ZHIHU_LIVE && !!process.env.ZHIHU_ACCESS_SECRET
}

/** 真实调用计数（进程内累计，额度观测/测试报告用；不含任何凭证信息） */
export const zhihuCounters = { search: 0, hotList: 0, quota: 0 }

/**
 * 从知乎 URL 提取问题 id（/question/<digits>/）。
 * /search 候选提取、回答归属强校验、hot_list 过滤共用这一条规则。
 * 非问题页（专栏文章 zhuanlan 等）返回 null。
 */
export function questionIdFromUrl(url: string): string | null {
  const m = /\/question\/(\d{1,20})(?:\/|\?|#|$)/.exec(url.trim())
  return m?.[1] ?? null
}

/* --------------------------- 业务错误码映射 --------------------------- */

export function mapZhihuCode(code: number): { errorCode: ErrorCode; retryable: boolean } {
  switch (code) {
    case 0:
      return { errorCode: 'zhihu_error', retryable: true } // 0 是成功，调用方不该走到这
    case 10001: // 参数错误 —— 我们的构造问题，不盲目重试
      return { errorCode: 'parse_error', retryable: false }
    case 20001: // 鉴权失败 —— 不可重试，告警查凭证
      return { errorCode: 'zhihu_error', retryable: false }
    case 30001: // 频率限制 —— 退避后重试
      return { errorCode: 'zhihu_error', retryable: true }
    case 30002: // 配额耗尽 —— 不可重试，次日恢复
      return { errorCode: 'quota_exhausted', retryable: false }
    case 90001: // 内部错误 —— 有限重试
      return { errorCode: 'zhihu_error', retryable: true }
    default:
      return { errorCode: 'zhihu_error', retryable: true }
  }
}

/* ------------------------- 真实响应形状（实测） ------------------------- */

/** zhihu_search 的 Item（实测字段，全部按需声明） */
export interface ZhihuItem {
  Title?: string
  /** "Answer" | "Article"（专栏）—— 只收 Answer */
  ContentType?: string
  /** 内容 id（回答 id），实测为 String */
  ContentID?: string
  ContentText?: string
  /** 带 UTM 的原文链接，原样透传 */
  Url?: string
  CommentCount?: number | string
  /** 注意：是 VoteUpCount，不是 VoteUp */
  VoteUpCount?: number | string
  AuthorName?: string
  /** 认证标图片 URL —— 不使用 */
  AuthorBadge?: string
  /** 认证文案 —— 只用这个 */
  AuthorBadgeText?: string
  /** String "1"–"4" */
  AuthorityLevel?: string | number
}

interface ZhihuEnvelope {
  Code?: number
  Message?: string
  Data?: { Items?: ZhihuItem[]; Total?: number; HasMore?: boolean } | ZhihuItem[] | null
}

/* -------------------------------- 工具 -------------------------------- */

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${process.env.ZHIHU_ACCESS_SECRET ?? ''}`,
    'X-Request-Timestamp': String(unixSeconds()),
    'Content-Type': 'application/json',
  }
}

function itemsOf(payload: ZhihuEnvelope): ZhihuItem[] {
  const d = payload.Data
  if (Array.isArray(d)) return d
  if (d && Array.isArray(d.Items)) return d.Items
  return []
}

function assertOk(payload: ZhihuEnvelope, op: string): void {
  const code = payload.Code
  if (typeof code !== 'number') return // 有些接口不带 Code，视为成功
  if (code === 0) return
  const { errorCode, retryable } = mapZhihuCode(code)
  // 只记 code 与映射结果，不记完整响应体
  log.warn('zhihu.businessError', { op, code, errorCode, retryable })
  throw new ZhihuError(`zhihu ${op} failed (code=${code})`, errorCode, retryable, code)
}

async function getJson(
  path: string,
  params: Record<string, string | number>,
): Promise<ZhihuEnvelope> {
  const url = new URL(path, BASE)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v))

  let res: Response
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: authHeaders(),
      signal: AbortSignal.timeout(15_000),
    })
  } catch (e) {
    throw new ZhihuError(`zhihu network error: ${String(e).slice(0, 200)}`, 'zhihu_error', true)
  }
  if (res.status === 401 || res.status === 403) {
    // 鉴权失败不可重试（docs/03 §8.4：20001 等价）
    throw new ZhihuError(`zhihu auth rejected (http ${res.status})`, 'zhihu_error', false, 20001)
  }
  if (res.status === 429) {
    throw new ZhihuError('zhihu rate limited', 'zhihu_error', true, 30001)
  }
  if (!res.ok) {
    throw new ZhihuError(`zhihu http ${res.status}`, 'zhihu_error', true)
  }
  try {
    return (await res.json()) as ZhihuEnvelope
  } catch {
    throw new ZhihuError('zhihu response is not json', 'parse_error', true)
  }
}

/* ------------------------------ 对外能力 ------------------------------ */

export interface HotQuestion {
  qid: string
  title: string
  url: string
}

/**
 * 知乎热榜 GET /api/v1/content/hot_list
 * Limit 默认 30、最大 30；返回问题与文章两类，按 Url 过滤只留 question。
 */
export async function hotList(limit = 30): Promise<HotQuestion[]> {
  if (!isLive()) throw new ZhihuError('zhihu disabled (ZHIHU_LIVE=0)', 'zhihu_error', false)
  zhihuCounters.hotList++
  const payload = await getJson('/api/v1/content/hot_list', { Limit: Math.min(30, limit) })
  assertOk(payload, 'hot_list')

  const out: HotQuestion[] = []
  const seen = new Set<string>()
  for (const it of itemsOf(payload)) {
    const url = (it.Url ?? '').trim()
    const m = /question\/(\d+)/.exec(url)
    if (!m) continue // 文章类，跳过
    const qid = m[1]!
    if (seen.has(qid)) continue
    seen.add(qid)
    out.push({ qid, title: (it.Title ?? '').trim() || `问题 ${qid}`, url })
  }
  log.info('zhihu.hotList', { count: out.length })
  return out
}

/** 知乎搜索 GET /api/v1/content/zhihu_search：Count 最大 10，>10 截断 */
export async function search(query: string, count = 10): Promise<ZhihuItem[]> {
  if (!isLive()) throw new ZhihuError('zhihu disabled (ZHIHU_LIVE=0)', 'zhihu_error', false)
  if (!query.trim()) throw new ZhihuError('zhihu search: empty query', 'parse_error', false)
  zhihuCounters.search++
  const payload = await getJson('/api/v1/content/zhihu_search', {
    Query: query,
    Count: Math.max(1, Math.min(10, count)),
  })
  assertOk(payload, 'zhihu_search')
  const items = itemsOf(payload).filter((it) => it.ContentType !== 'Article')
  log.info('zhihu.search', { count: items.length })
  return items
}

export interface QuotaMap {
  zhihu_search: number | null
  hot_list: number | null
  zhida_openai: number | null
}

/**
 * 额度查询 GET /api/v1/quota —— 查询本身不消耗额度。
 * 不可达 / 未放行时返回 null，调用方降级（/health 仍 ok:true）。
 */
export async function quota(): Promise<QuotaMap | null> {
  if (!isLive()) {
    log.debug('zhihu.quota.skipped', { live: false, ...zhihuSecretStatus() })
    return null
  }
  zhihuCounters.quota++
  try {
    const payload = await getJson('/api/v1/quota', {
      APIIDs: 'zhihu_search,hot_list,zhida_openai',
    })
    assertOk(payload, 'quota')
    // keys-only 形状日志：值不打印（额度数字无害，但保持日志最小化），形状变化立刻可见
    const data = (payload as { Data?: unknown }).Data
    log.debug('zhihu.quota.shape', {
      topKeys: Object.keys(payload as object),
      dataKind: Array.isArray(data) ? `array(${data.length})` : typeof data,
      rowKeys:
        Array.isArray(data) && data[0] && typeof data[0] === 'object'
          ? Object.keys(data[0] as object)
          : null,
    })
    return normalizeQuota(data)
  } catch (e) {
    // 额度查询失败绝不能拖挂 /health
    log.warn('zhihu.quota.failed', {
      reason: e instanceof Error ? e.message.slice(0, 160) : String(e).slice(0, 160),
    })
    return null
  }
}

/**
 * 额度响应形状（2026-09-12 实测收紧）：
 *   Data 是数组，元素 { APIID, APIName, TotalQuota, TotalUsed, RemainingQuota }。
 * 只认 APIID + RemainingQuota 字段；缺字段/非法值 → null（额度未知），绝不谎报 0。
 */
function normalizeQuota(data: unknown): QuotaMap {
  const out: QuotaMap = { zhihu_search: null, hot_list: null, zhida_openai: null }
  if (!Array.isArray(data)) return out
  for (const row of data as Array<Record<string, unknown>>) {
    const id = typeof row?.APIID === 'string' ? row.APIID : ''
    if (!(id in out)) continue
    const n = Number(row.RemainingQuota)
    if (Number.isFinite(n) && n >= 0) out[id as keyof QuotaMap] = Math.trunc(n)
  }
  return out
}

/** AuthorityLevel：源接口返回 String（"1"–"4"），入库转 number，越界收敛到 1–4 */
export function normalizeAuthority(raw: ZhihuItem['AuthorityLevel']): 1 | 2 | 3 | 4 {
  const n = Number(raw)
  if (!Number.isFinite(n)) return 1
  const c = Math.trunc(n)
  if (c <= 1) return 1
  if (c >= 4) return 4
  return c === 2 ? 2 : 3
}
