/**
 * GET /api/v1/search?q=<问题文字>（契约 §4.5 / ENDPOINTS.search）
 *
 * 产品决策（2026-09-12 用户拍板）：产品输入只有「问题文字」，qid 不作任何
 * 标题解析的输入。本路由是「问题文字 → 候选题」的正向入口：
 *   zhihu_search(q) → Url 提取 /question/<qid>/ → 按问题维度去重 → ≤8 条 {qid,title}
 *   → 命中结果写入 question_titles 永久缓存（幂等预热，ON CONFLICT DO NOTHING）
 *   → 内存 LRU（1h TTL），同一搜索词 1h 内不重复消耗 zhihu_search 额度
 *
 * 实测（2026-09-12）：zhihu_search 条目的 Title 就是问题标题（带「 - 知乎」
 * 后缀，剥掉）；专栏文章 Url 为 zhuanlan.zhihu.com，提取不到 qid 自然被滤掉。
 * qid 仅作内部资源键，不对用户暴露，也永不作为标题解析的输入。
 */

import { Hono } from 'hono'
import { SearchResp } from '@two-sides/contract'
import { failResp, okData } from '../http'
import { log } from '../log'
import { cacheQuestionTitle } from '../repo'
import { isLive, questionIdFromUrl, search, ZhihuError } from '../zhihu/client'

export const searchRoutes = new Hono()

/** 内存 LRU：同一搜索词 1h 内直接回缓存（zhihu_search 5000/日，省着点花） */
const LRU_MAX = 100
const LRU_TTL_MS = 3_600_000
type Candidate = { qid: string; title: string }
const lru = new Map<string, { items: Candidate[]; at: number }>()

/** 搜索词规范化：trim + 折叠空白 + 100 字上限 */
function normalizeQuery(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').slice(0, 100)
}

/** 剥掉实测恒定的「 - 知乎」站点后缀，其余原样保留 */
function cleanCandidateTitle(raw: string): string {
  return raw.replace(/\s*[-–—]\s*知乎\s*$/u, '').trim()
}

function lruGet(key: string): Candidate[] | null {
  const hit = lru.get(key)
  if (!hit) return null
  if (Date.now() - hit.at >= LRU_TTL_MS) {
    lru.delete(key)
    return null
  }
  // LRU touch：删了重插，保持 Map 插入序 = 访问序
  lru.delete(key)
  lru.set(key, hit)
  return hit.items
}

function lruPut(key: string, items: Candidate[]): void {
  lru.set(key, { items, at: Date.now() })
  if (lru.size > LRU_MAX) {
    const oldest = lru.keys().next().value
    if (oldest !== undefined) lru.delete(oldest)
  }
}

searchRoutes.get('/search', async (c) => {
  const q = normalizeQuery(c.req.query('q') ?? '')
  if (!q) return failResp(c, 400, '缺少搜索词 q')

  const key = q.toLowerCase()
  const cached = lruGet(key)
  if (cached) {
    log.debug('search.lru.hit', { count: cached.length })
    return okData(c, 200, SearchResp.parse({ items: cached }))
  }

  if (!isLive()) {
    // 搜索是本路由的全部能力，闸门关着就没有可降级的结果
    return failResp(c, 503, '搜索服务未开放')
  }

  try {
    // Count 上限 10：取一页足够挑出 ≤8 道去重后的题
    const items = await search(q, 10)
    const byQuestion = new Map<string, string>()
    for (const it of items) {
      const qid = questionIdFromUrl(it.Url ?? '')
      const title = it.Title ? cleanCandidateTitle(it.Title) : ''
      if (!qid || title.length < 4 || byQuestion.has(qid)) continue
      byQuestion.set(qid, title)
      if (byQuestion.size >= 8) break
    }

    const out: Candidate[] = [...byQuestion].map(([qid, title]) => ({ qid, title }))
    // 缓存预热：候选题的标题入 question_titles（幂等，首次为准），
    // 用户点选后 analysis 的 titleHint 就有了着落
    for (const it of out) cacheQuestionTitle(it.qid, it.title, 'search')

    lruPut(key, out)
    log.info('search.served', { count: out.length })
    return okData(c, 200, SearchResp.parse({ items: out }))
  } catch (e) {
    if (e instanceof ZhihuError) {
      log.warn('search.zhihuFailed', { errorCode: e.errorCode, zhihuCode: e.zhihuCode ?? null })
      const status = e.errorCode === 'quota_exhausted' ? 429 : e.retryable ? 503 : 502
      return failResp(c, status, '搜索服务暂时不可用，请稍后重试')
    }
    log.error('search.unexpected', {
      reason: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200),
    })
    return failResp(c, 500, '服务内部错误')
  }
})
