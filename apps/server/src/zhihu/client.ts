/**
 * 知乎开放平台客户端
 *
 * docs/03 §8：
 *  - 统一鉴权：Authorization: Bearer <ZHIHU_ACCESS_SECRET> + X-Request-Timestamp（秒级）
 *  - 基础域名 https://developer.zhihu.com（Access Secret 不发送到其他主机）
 *  - 内容接口可能在 HTTP 200 里返回业务错误（Code != 0），必须判 Code
 *  - 错误码映射见 §8.4
 *
 * D0 闸门：默认不发真实请求（ZHIHU_LIVE=1 且凭证已配置才放行），
 * 防止开发期烧掉黑客松日额度。未放行时 quota() 返回 null，调用方降级。
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

/* ------------------------------ 原始形状 ------------------------------ */

/**
 * 开放平台字段名以实际联调为准；这里只声明我们用到的部分且全部可选，
 * 用宽松解析兜底，避免字段缺失直接崩。D1 联调时按真实 payload 收紧。
 */
interface ZhihuAuthor {
  Name?: string
  AuthorBadgeText?: string
  /** 源接口返回 String（"1"–"4"），必须转 number */
  AuthorityLevel?: string | number
}

interface ZhihuItem {
  Url?: string
  Title?: string
  ContentText?: string
  VoteUp?: number | string
  Author?: ZhihuAuthor
  CommentInfoList?: Array<{ Content?: string }>
}

interface ZhihuEnvelope {
  Code?: number
  Message?: string
  Data?: unknown
  data?: unknown
}

/* -------------------------------- 工具 -------------------------------- */

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${process.env.ZHIHU_ACCESS_SECRET ?? ''}`,
    'X-Request-Timestamp': String(unixSeconds()),
    'Content-Type': 'application/json',
  }
}

function unwrapData(payload: ZhihuEnvelope): unknown {
  if (Array.isArray(payload)) return payload
  if (payload.Data !== undefined) return payload.Data
  if (payload.data !== undefined) return payload.data
  return undefined
}

function assertOk(payload: ZhihuEnvelope, op: string): void {
  const code = payload.Code
  if (typeof code !== 'number') return // 有些接口不带 Code，视为成功
  if (code === 0) return
  const { errorCode, retryable } = mapZhihuCode(code)
  // 只记 code 与简短 message，不记完整响应体
  log.warn('zhihu.businessError', { op, code, errorCode, retryable })
  throw new ZhihuError(`zhihu ${op} failed (code=${code})`, errorCode, retryable, code)
}

async function getJson(path: string, params: Record<string, string | number>): Promise<ZhihuEnvelope> {
  const url = new URL(path, BASE)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v))

  let res: Response
  try {
    res = await fetch(url, { method: 'GET', headers: authHeaders(), signal: AbortSignal.timeout(15_000) })
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
  const payload = await getJson('/api/v1/content/hot_list', { Limit: Math.min(30, limit) })
  assertOk(payload, 'hot_list')

  const data = unwrapData(payload)
  const list: ZhihuItem[] = Array.isArray(data)
    ? (data as ZhihuItem[])
    : Array.isArray((data as { Data?: ZhihuItem[] })?.Data)
      ? ((data as { Data: ZhihuItem[] }).Data ?? [])
      : []

  const out: HotQuestion[] = []
  const seen = new Set<string>()
  for (const it of list) {
    const url = it.Url ?? ''
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
  const payload = await getJson('/api/v1/content/zhihu_search', {
    Query: query,
    Count: Math.max(1, Math.min(10, count)),
  })
  assertOk(payload, 'zhihu_search')
  const data = unwrapData(payload)
  const list = Array.isArray(data)
    ? (data as ZhihuItem[])
    : Array.isArray((data as { Data?: ZhihuItem[] })?.Data)
      ? ((data as { Data: ZhihuItem[] }).Data ?? [])
      : []
  log.info('zhihu.search', { count: list.length })
  return list
}

export interface QuotaMap {
  zhihu_search: number
  hot_list: number
  zhida_openai: number
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
  try {
    const payload = await getJson('/api/v1/quota', {
      APIIDs: 'zhihu_search,hot_list,zhida_openai',
    })
    assertOk(payload, 'quota')
    return normalizeQuota(unwrapData(payload))
  } catch (e) {
    // 额度查询失败绝不能拖挂 /health
    log.warn('zhihu.quota.failed', {
      reason: e instanceof Error ? e.message.slice(0, 160) : String(e).slice(0, 160),
    })
    return null
  }
}

/**
 * 额度响应形状不确定（可能是 map / 数组 / 嵌套），统一收敛成三个数。
 * 取不到就 -1，让前端知道「未知」而不是谎报 0。
 */
function normalizeQuota(data: unknown): QuotaMap {
  const out: QuotaMap = { zhihu_search: -1, hot_list: -1, zhida_openai: -1 }
  const put = (key: string, val: unknown) => {
    if (!(key in out)) return
    const n = typeof val === 'number' ? val : Number(val)
    if (Number.isFinite(n)) out[key as keyof QuotaMap] = Math.max(-1, Math.trunc(n))
  }
  if (Array.isArray(data)) {
    for (const row of data as Array<Record<string, unknown>>) {
      const id = String(row.APIID ?? row.ApiId ?? row.api_id ?? row.Name ?? '')
      const remain = row.Remain ?? row.Remaining ?? row.Quota ?? row.Limit ?? row.Value
      put(id, remain)
    }
    return out
  }
  if (data && typeof data === 'object') {
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      if (v && typeof v === 'object') {
        const inner = v as Record<string, unknown>
        put(k, inner.Remain ?? inner.Remaining ?? inner.Quota ?? inner.Limit ?? inner.Value)
      } else {
        put(k, v)
      }
    }
  }
  return out
}

/** 把 AuthorBadgeText / AuthorityLevel 收敛成契约类型（String → number） */
export function normalizeAuthority(raw: ZhihuItem['Author']): 1 | 2 | 3 | 4 {
  const n = Number(raw?.AuthorityLevel)
  if (!Number.isFinite(n)) return 1
  const c = Math.trunc(n)
  if (c <= 1) return 1
  if (c >= 4) return 4
  return c === 2 ? 2 : 3
}

export type { ZhihuItem, ZhihuAuthor }
