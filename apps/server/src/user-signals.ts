/**
 * 用户信号（「这道题与你有关吗」）
 *
 * 背景（2026-09-13，用户拍板 + 两轮实测）：
 *   开放平台**没有「关注了哪些问题」的接口** —— `user_followees` 是「关注的用户」，
 *   不是关注的问题；`user_collections` 实测对该账号返回 0 条。所以「关注问题」
 *   这个信号原样做不到。
 *
 * 采用的口径只有两个，都是 id 级精确匹配、零误判：
 *   ① question_favorited —— 收藏夹里 `ContentType=question` 的条目 Url 含 `/question/<qid>`
 *   ② answer_favorited   —— 收藏夹里回答条目的 `/answer/<id>`，与快照内答主原链的回答 id 求交
 *
 * 明确不做：按昵称匹配「你关注的人是不是这题的答主」。`user_followees` 给的是
 * Fullname / UrlToken，而我们的 AuthorRef 只有昵称，只能靠昵称相等判断 ——
 * 重名即误判，且标记文案会变成对「同一个人」的断言。宁缺毋滥，不做。
 *
 * 诚实边界：`answer_favorited` 只能命中「被写进光谱的答主」。一条回答若在归类阶段
 * 被判为「不涉及任何议题」，它不会出现在快照里，因此收藏它不会点亮标记 ——
 * 只会漏报，不会误报。
 */

import type { RelatedItem, RelatedReason } from '@two-sides/contract'
import { env } from './env'
import { log } from './log'
import { getAnalysis, listReadyHot } from './repo'
import { todayKey } from './time'
import { answerIdFromFavUrl, favlistContents, favlists, questionIdFromFavUrl } from './zhihu/user'
import { ZhihuError } from './zhihu/client'

export interface UserSignals {
  /** 收藏过的问题 qid */
  questions: Set<string>
  /** 收藏过的回答 id */
  answers: Set<string>
  /** 扫了几个收藏夹 / 几条内容，供日志与诊断 */
  scannedLists: number
  scannedItems: number
  /** true = 本次没完整取到收藏（接口失败/额度），marks 可能不完整 —— 不代表「无关」 */
  degraded: boolean
  at: number
}

const EMPTY = (degraded: boolean): UserSignals => ({
  questions: new Set(),
  answers: new Set(),
  scannedLists: 0,
  scannedItems: 0,
  degraded,
  at: Date.now(),
})

/** 会话级缓存：同一会话在 TTL 内不重复扫收藏（user_data 额度 10000/日，仍要省） */
const cache = new Map<string, UserSignals>()

/** 会话登出/过期时顺手清掉，避免 Map 无限增长 */
export function forgetSignals(sessionId: string): void {
  cache.delete(sessionId)
}

/** 只读缓存（不触发网络）：用于不需要重新扫描的诊断入口 */
export function peekSignals(sessionId: string): UserSignals | undefined {
  const hit = cache.get(sessionId)
  if (!hit) return undefined
  if (Date.now() - hit.at >= env.USER_SIGNAL_TTL_SEC * 1000) {
    cache.delete(sessionId)
    return undefined
  }
  return hit
}

/**
 * 扫用户的收藏，得到「收藏过的问题」与「收藏过的回答」两个集合。
 * **永不抛错**：任何失败都降级为空集 + degraded 标记（宁可少点亮，不可误断言）。
 */
export async function loadSignals(sessionId: string, oauthToken: string): Promise<UserSignals> {
  const hit = peekSignals(sessionId)
  if (hit) return hit

  const signals = EMPTY(false)
  try {
    const lists = (await favlists(oauthToken, env.FAV_SCAN_LISTS * 2)).slice(0, env.FAV_SCAN_LISTS)
    signals.scannedLists = lists.length
    for (const list of lists) {
      if (list.UrlToken === undefined || list.UrlToken === null) continue
      for (let page = 0; page < env.FAV_SCAN_PAGES; page++) {
        // 自算 offset，不采信服务端的 IsEnd / NextOffset（实测自相矛盾，见 zhihu/user.ts）
        const items = await favlistContents(oauthToken, list.UrlToken, {
          offset: page * env.FAV_PAGE_SIZE,
          limit: env.FAV_PAGE_SIZE,
        })
        for (const it of items) {
          const url = it.Url ?? ''
          if (it.ContentType === 'question') {
            const qid = questionIdFromFavUrl(url)
            if (qid) signals.questions.add(qid)
          } else if (it.ContentType === 'answer') {
            const aid = answerIdFromFavUrl(url)
            if (aid) signals.answers.add(aid)
          }
          signals.scannedItems++
        }
        if (items.length < env.FAV_PAGE_SIZE) break
      }
    }
    log.info('userSignals.scanned', {
      lists: signals.scannedLists,
      items: signals.scannedItems,
      questions: signals.questions.size,
      answers: signals.answers.size,
    })
  } catch (e) {
    signals.degraded = true
    const kind = e instanceof ZhihuError ? `zhihu:${e.zhihuCode ?? e.errorCode}` : 'unexpected'
    log.warn('userSignals.degraded', {
      kind,
      lists: signals.scannedLists,
      items: signals.scannedItems,
      reason: e instanceof Error ? e.message.slice(0, 160) : String(e).slice(0, 160),
    })
  }

  cache.set(sessionId, signals)
  return signals
}

/* ---------------- 快照回答索引（按日缓存，避免每个请求重解 30 份 JSON） ---------------- */

interface AnswerIndex {
  /** 索引建立时当日 ready 题数：变了就重建（预生成会持续把题变 ready） */
  readyCount: number
  byQid: Map<string, Set<string>>
}

let indexCache: { date: string; index: AnswerIndex } | null = null

/** 从一份快照里取出「出现在光谱里的回答 id」——快照里唯一带回答 id 的字段是答主原链 */
function answerIdsOf(snapshot: unknown): Set<string> {
  const ids = new Set<string>()
  const judgments = (snapshot as { judgments?: Array<{ distribution?: Array<{ authors?: Array<{ url?: string }> }> }> })
    ?.judgments
  for (const j of judgments ?? []) {
    for (const bucket of j.distribution ?? []) {
      for (const a of bucket.authors ?? []) {
        const aid = answerIdFromFavUrl(a.url ?? '')
        if (aid) ids.add(aid)
      }
    }
  }
  return ids
}

function indexQid(date: string, qid: string, into: Map<string, Set<string>>): void {
  const row = getAnalysis(date, qid)
  if (!row?.data) return
  try {
    const ids = answerIdsOf(JSON.parse(row.data))
    if (ids.size > 0) into.set(qid, ids)
  } catch {
    log.warn('userSignals.indexParseFailed', { date, qid })
  }
}

/** 当日每道 ready 题的回答索引（按 ready 题数缓存） */
export function answerIndexFor(date: string): Map<string, Set<string>> {
  const ready = listReadyHot(date)
  if (indexCache && indexCache.date === date && indexCache.index.readyCount === ready.length) {
    return indexCache.index.byQid
  }
  const byQid = new Map<string, Set<string>>()
  for (const { qid } of ready) indexQid(date, qid, byQid)
  log.info('userSignals.indexBuilt', { date, questions: byQid.size })
  indexCache = { date, index: { readyCount: ready.length, byQid } }
  return byQid
}

/**
 * 单题的回答索引：优先命中当日缓存；带外 qid（不在 ready 热榜里）就地读那一份。
 * 带外题不会进缓存 —— 它只有一次，缓存反而会拖大重建成本。
 */
function answerIdsFor(date: string, qid: string, cached: Map<string, Set<string>>): Set<string> | undefined {
  const hit = cached.get(qid)
  if (hit) return hit
  const one = new Map<string, Set<string>>()
  indexQid(date, qid, one)
  return one.get(qid)
}

/** 测试/诊断用：清掉按日索引缓存 */
export function resetAnswerIndex(): void {
  indexCache = null
}

/* ------------------------------- 标记计算 ------------------------------- */

/**
 * 输出「与你有关」的题 + 原因。顺序沿用热榜顺序；extraQid 用于带外直接打开的问题页。
 * 无标记的题不出现在结果里（缺省即「无从判断」，不构成任何断言）。
 */
export function relatedMarks(date: string, signals: UserSignals, extraQid?: string): RelatedItem[] {
  const index = answerIndexFor(date)
  const qids = listReadyHot(date).map((h) => h.qid)
  if (extraQid && !qids.includes(extraQid)) qids.push(extraQid)

  const out: RelatedItem[] = []
  for (const qid of qids) {
    const reasons: RelatedReason[] = []
    if (signals.questions.has(qid)) reasons.push('question_favorited')
    if (signals.answers.size > 0) {
      const ids = answerIdsFor(date, qid, index)
      if (ids) {
        for (const id of ids) {
          if (signals.answers.has(id)) {
            reasons.push('answer_favorited')
            break
          }
        }
      }
    }
    if (reasons.length > 0) out.push({ qid, reasons })
  }
  return out
}

/** 供路由使用的便捷入口（会话已鉴权时） */
export async function relatedForSession(
  sessionId: string,
  oauthToken: string,
  extraQid?: string,
): Promise<{ authorized: true; degraded?: boolean; items: RelatedItem[] }> {
  const signals = await loadSignals(sessionId, oauthToken)
  const date = todayKey()
  return {
    authorized: true,
    ...(signals.degraded ? { degraded: true } : {}),
    items: relatedMarks(date, signals, extraQid),
  }
}
