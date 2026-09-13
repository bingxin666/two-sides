/**
 * 知乎用户数据客户端（`/api/v1/user/*`）
 *
 * 鉴权两层，缺一不可：
 *   Authorization: Bearer <Access Secret>   —— 证明「调用方是谁」
 *   X-OAuth-Token: <用户 access_token>      —— 证明「代表哪个用户」
 * 只有两者同时成立，才拿得到被授权用户的公开数据。token 只在请求头出现，
 * 永不写日志、永不回给前端、永不落库。
 *
 * 本项目只用两个接口（docs/03 §8.2）：
 *   GET /api/v1/user/favlists          → 收藏夹列表
 *   GET /api/v1/user/favlist_contents  → 收藏夹内容（含 ContentType=question 的题）
 *
 * ⚠️ 实测踩坑（2026-09-13，两轮探测）：
 *   · 分页元数据**不可信**：同一个 33001 条的收藏夹，Offset=0/Limit=20 返回
 *     `{IsEnd:false, NextOffset:"20", Totals:33001}`，Offset=20 却返回
 *     `{IsEnd:true, Totals:39}`，Offset=50 又回到 `{IsEnd:false, Totals:33001}`。
 *     IsEnd 与 Totals 自相矛盾。**因此本项目不采信 IsEnd / NextOffset**，
 *     改用自算 Offset，且只取前几页（见 user-signals.ts）。
 *   · 排序是**新→旧**（Offset=0 与 Offset=50 的首条 id 单调递减）；
 *     我们只需要「最近收藏」，故翻页深度很浅即可。
 *   · 条目数量可能略少于 Limit（有被过滤项）：Limit=50 实测返回 49。
 */

import type { ErrorCode } from '@two-sides/contract'
import { isLive, zhihuCounters, zhihuGet, ZhihuError } from './client'
import { log } from '../log'

/** 收藏内容条目（只用得到的字段；其余字段原样忽略） */
export interface UserContentItem {
  /** answer / article / zvideo / pin / question */
  ContentType?: string
  Url?: string
  Title?: string
  Summary?: string
  /** 收藏时间，秒级 */
  FavTime?: number | string
  CreatedAt?: number | string
}

export interface FavlistItem {
  UrlToken?: number | string
  Url?: string
  Title?: string
  Description?: string
  IsPublic?: boolean
}

interface Envelope {
  Code?: number
  Message?: string
  Data?: { Items?: unknown[] } | null
}

function assertOk(payload: Envelope, op: string): void {
  const code = payload.Code
  if (typeof code !== 'number' || code === 0) return
  const retryable = code !== 20001 && code !== 30002
  const errorCode: ErrorCode = code === 30002 ? 'quota_exhausted' : 'zhihu_error'
  log.warn('zhihu.userData.businessError', { op, code, errorCode, retryable })
  throw new ZhihuError(`zhihu ${op} failed (code=${code})`, errorCode, retryable, code)
}

function itemsOf(payload: Envelope): Array<Record<string, unknown>> {
  const items = payload.Data?.Items
  if (!Array.isArray(items)) return []
  return items.filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object')
}

function live(op: string): void {
  if (!isLive()) throw new ZhihuError(`zhihu disabled (ZHIHU_LIVE=0): ${op}`, 'zhihu_error', false)
}

/** 用户的收藏夹列表。Limit 默认 20（实测 50 也被接受）。 */
export async function favlists(oauthToken: string, limit = 20): Promise<FavlistItem[]> {
  live('user/favlists')
  zhihuCounters.userData++
  const payload = (await zhihuGet('/api/v1/user/favlists', { Limit: Math.max(1, Math.min(50, limit)) }, {
    extraHeaders: { 'X-OAuth-Token': oauthToken },
  })) as Envelope
  assertOk(payload, 'user/favlists')
  const out = itemsOf(payload).map<FavlistItem>((r) => ({
    UrlToken: r.UrlToken as FavlistItem['UrlToken'],
    Url: typeof r.Url === 'string' ? r.Url : undefined,
    Title: typeof r.Title === 'string' ? r.Title : undefined,
    Description: typeof r.Description === 'string' ? r.Description : undefined,
    IsPublic: typeof r.IsPublic === 'boolean' ? r.IsPublic : undefined,
  }))
  log.info('zhihu.favlists', { count: out.length })
  return out
}

/**
 * 指定收藏夹的内容。**不采信服务端分页字段**，由调用方显式给 offset。
 * 实测 Limit 上限至少到 100；本项目用 50，避免一次拖太多正文进内存。
 */
export async function favlistContents(
  oauthToken: string,
  favlistUrlToken: string | number,
  opts: { offset?: number; limit?: number } = {},
): Promise<UserContentItem[]> {
  live('user/favlist_contents')
  zhihuCounters.userData++
  const payload = (await zhihuGet('/api/v1/user/favlist_contents', {
    FavlistUrlToken: favlistUrlToken,
    Offset: Math.max(0, opts.offset ?? 0),
    Limit: Math.max(1, Math.min(50, opts.limit ?? 20)),
  }, {
    extraHeaders: { 'X-OAuth-Token': oauthToken },
  })) as Envelope
  assertOk(payload, 'user/favlist_contents')
  const out = itemsOf(payload).map<UserContentItem>((r) => ({
    ContentType: typeof r.ContentType === 'string' ? r.ContentType : undefined,
    Url: typeof r.Url === 'string' ? r.Url : undefined,
    Title: typeof r.Title === 'string' ? r.Title : undefined,
    Summary: typeof r.Summary === 'string' ? r.Summary : undefined,
    FavTime: r.FavTime as UserContentItem['FavTime'],
  }))
  log.info('zhihu.favlistContents', { items: out.length, offset: opts.offset ?? 0 })
  return out
}

/** 问题链接 → qid；非问题页返回 null */
export function questionIdFromFavUrl(url: string): string | null {
  return /\/question\/(\d{1,20})/.exec(url)?.[1] ?? null
}

/**
 * 回答链接 → 回答 id。
 * 兼容两种实测形态：`https://www.zhihu.com/answer/<id>`（收藏接口）
 * 与 `https://www.zhihu.com/question/<qid>/answer/<id>`（搜索接口）。
 */
export function answerIdFromFavUrl(url: string): string | null {
  return /\/answer\/(\d{1,20})/.exec(url)?.[1] ?? null
}
