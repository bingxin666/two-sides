/**
 * 增强层 · 用户态（登录状态 + 「与你有关」标记）
 *
 * 设计要点：
 *   - N1 与 N2 共用一份标记，进问题页不再二次请求（标记是当日热榜维度的，
 *     只有带外 qid 才需要补一次问）
 *   - 登录态与标记一次拉完：`getRelated()` 的 authorized 就是登录态，
 *     不必依赖 /auth/zhihu/status 才能判断「要不要显示登录按钮」
 *   - 任何失败都安静降级为「未登录 / 无标记」：这是增强层，绝不能拖挂主流程
 *   - TTL 到期（默认 5 分钟）后下次进入首页会重新拉；OAuth 回跳会强制刷新
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { RelatedReason } from '@two-sides/contract'
import { getRelated, getZhihuStatus, logoutZhihu } from '@/api'

/** 本地 TTL：比后端 USER_SIGNAL_TTL_SEC(600s) 短，保证前端不会长期用陈旧标记 */
const TTL_MS = 5 * 60_000

export const useUserStore = defineStore('user', () => {
  /** null = 还没问过服务端（用于区分「没登录」与「还没查」） */
  const authorized = ref<boolean | null>(null)
  const expiresAt = ref<number | null>(null)
  /** qid → 原因列表 */
  const marks = ref<Map<string, RelatedReason[]>>(new Map())
  /** true = 后端取收藏失败，标记可能不完整（不构成「无关」的断言） */
  const degraded = ref(false)
  const oauthConfigured = ref(true)

  let loadedAt = 0
  let inflight: Promise<void> | null = null

  const isLoggedIn = computed(() => authorized.value === true)

  function reasonsFor(qid: string): RelatedReason[] {
    return marks.value.get(qid) ?? []
  }

  /** 标记文案：两种原因同时命中时，按「收藏过这道题」优先（更具体） */
  function labelFor(qid: string): string {
    const reasons = reasonsFor(qid)
    if (reasons.includes('question_favorited')) return '你收藏过这道题'
    if (reasons.includes('answer_favorited')) return '你收藏过这题里的回答'
    return ''
  }

  async function refresh(extraQid?: string): Promise<void> {
    if (inflight) {
      await inflight
      // 已有结果里没覆盖带外 qid 的话，补一次
      if (!extraQid || marks.value.has(extraQid)) return
    }
    inflight = (async () => {
      try {
        const [status, related] = await Promise.all([
          getZhihuStatus().catch(() => null),
          getRelated(extraQid),
        ])
        if (status) {
          oauthConfigured.value = status.configured
          expiresAt.value = status.authorized ? status.expiresAt : null
        }
        authorized.value = related.authorized
        degraded.value = related.degraded === true
        const next = new Map<string, RelatedReason[]>()
        for (const item of related.items) next.set(item.qid, item.reasons)
        marks.value = next
        loadedAt = Date.now()
      } catch {
        // 增强层失败：安静降级，不打扰主流程（热榜与问题页照常）
        authorized.value = authorized.value ?? false
        degraded.value = true
      } finally {
        inflight = null
      }
    })()
    await inflight
  }

  /** 首次进入 / 超过 TTL 才真正请求；force 用于 OAuth 回跳后强制刷新 */
  async function ensureLoaded(extraQid?: string, force = false): Promise<void> {
    if (!force && authorized.value !== null && Date.now() - loadedAt < TTL_MS) {
      if (!extraQid || marks.value.has(extraQid)) return
    }
    await refresh(extraQid)
  }

  /** OAuth 回跳后调用：丢掉旧标记，全量重拉（收藏可能刚变） */
  async function reloadAfterOauth(): Promise<void> {
    marks.value = new Map()
    loadedAt = 0
    await refresh()
  }

  async function signOut(): Promise<void> {
    try {
      await logoutZhihu()
    } catch {
      // 退出失败也让本地立刻无标记：宁可少标，不留过期身份
    }
    authorized.value = false
    expiresAt.value = null
    marks.value = new Map()
    degraded.value = false
    loadedAt = Date.now()
  }

  return {
    authorized,
    expiresAt,
    marks,
    degraded,
    oauthConfigured,
    isLoggedIn,
    reasonsFor,
    labelFor,
    ensureLoaded,
    refresh,
    reloadAfterOauth,
    signOut,
  }
})
