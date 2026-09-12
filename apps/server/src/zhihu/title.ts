/**
 * 题目标题解析 —— 仅两级，零网络（2026-09-12 产品所有者拍板）
 *
 * ⚠️ 产品决策：**产品输入只有「问题文字」，qid 不作为任何标题解析的输入，
 * qid 相关的反查路径全部不存在。** 工程完备性让位于产品决策。
 *
 * 标题的合法来源只有三个（全部来自「问题文字」）：
 *   1. titleHint —— hot_list 预生成 / /search 候选 / 上游 ?title= 传入
 *   2. question_titles 永久缓存（首次写入为准，每题一生一次）
 *   3. 都没有 → 返回空串，调用方置 failed(zhihu_error)，绝不假造
 *
 * 三条已实测的死路（留档防后人「优化」回去，别再试）：
 *   ✗ og:title 直接抓问题页：知乎 zse-ck JS 风控挑战拦截，Bun fetch 得 403，
 *     curl 同 UA 也只拿到 650 字节挑战页（无浏览器执行环境不可能拿到 meta）
 *   ✗ global_search 按 qid 查：纯文本搜索不索引 qid，实测 Code 0 但
 *     Items=0（EmptyReason「无相关内容」）；标题作 Query 返回的是外部网页
 *   ✗ hot_list 按 qid 匹配：URL 寻址虽安全，但产品决策 qid 反查路径根本
 *     不该存在（2026-09-12 砍掉，仅存续约 2 小时）
 *
 * zhihu_search 永远禁止用于标题推断（D1 实测：纯 qid 查询会命中完全无关的题）。
 */

import { cacheQuestionTitle, getQuestionTitle } from '../repo'

export const titleCounters = { hintHit: 0, cacheHit: 0, miss: 0 }

/**
 * 解析题目标题。纯本地查表（hint → 永久缓存），不发起任何网络请求。
 * 返回空串表示解析失败（调用方必须置 failed，绝不假造标题）。
 */
export function resolveQuestionTitle(qid: string, titleHint?: string): string {
  const hint = (titleHint ?? '').trim()
  if (hint) {
    titleCounters.hintHit++
    return hint
  }
  const cached = getQuestionTitle(qid)
  if (cached) {
    titleCounters.cacheHit++
    return cached.title
  }
  titleCounters.miss++
  return ''
}

/** titleHint 入缓存（幂等：ON CONFLICT DO NOTHING，首次为准） */
export function rememberHint(qid: string, titleHint: string): void {
  const t = titleHint.trim()
  if (t) cacheQuestionTitle(qid, t, 'hint')
}
