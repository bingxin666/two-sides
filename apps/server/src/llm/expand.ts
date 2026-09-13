/**
 * 查询语义扩写（2026-09-12 用户拍板：废除 8 个机械后缀变体，改 LLM 扩写）
 *
 * 最终查询集 = 原句 + ≤3 个「知乎用户可能提问这道题的相似问法」，去重后恰好 ≤4 条。
 * 承载：provider 层 expand agent（primary origami / deepseek-v4-flash，现有 failover 兜底），
 * temperature 0.7（多样但可控），单次 ~500 tok。
 *
 * 降级纪律：调用失败 / 超时（3s 硬上限，/search 搜索框不被 LLM 拖死）/ zod 不过
 * → 退回仅原句 1 条 + 结构化日志 expand.degraded，**绝不使用机械变体**（buildVariants 已删）。
 * 扩写只是查询生成器：回答准入判定仍是「主 qid + 已批准合并 qid 集合」的强校验，
 * 救援合并（Tier 1/Tier 2）原样保留 —— 扩写负责找到辩论，救援负责把辩论的回答并进来。
 */

import { z } from 'zod'
import { callAgent, type CallOptions } from './provider'
import { parseJsonLoose } from './client'
import { log } from '../log'

/** 扩写总超时上限（毫秒，含重试/限流/主备）。默认 10s：origami 实测首响 4–10s，3s 会让扩写
 * 永远降级（管线空转）；/search 交互路径显式传 3000（搜索框 UX 护栏，spec 口径） */
const EXPAND_TIMEOUT_DEFAULT_MS = 10_000

/** 模型直接输出 JSON 字符串数组（spec 口径「字符串数组恰好 3 项」），无包裹对象。
 * 模型偶尔超发：放宽到 5，服务端裁到 3。 */
const QueriesOut = z.array(z.string().min(4).max(160)).min(1).max(5)

const EXPAND_SYSTEM = [
  '你是查询扩写器。给你一道知乎上的争议问题，写出另外 3 个知乎用户可能提问这道题的相似问法。',
  '要求：',
  '1. 核心争议完全相同，只是措辞/角度/口语化程度不同。',
  '2. 每个都是自然的独立问题（不是关键词堆砌，不是带后缀的机械变形）。',
  '3. 不写答案、不写观点。',
  '输出 JSON：字符串数组恰好 3 项，例如 ["问法一","问法二","问法三"]，不要输出任何其他文字。',
].join('\n')

/** 扩写观测计数（进程内累计；不参与业务判断） */
export const expandCounters = { calls: 0, degraded: 0 }

/**
 * 生成最终查询集：[原句, ...扩写]。永不抛错 —— 任何失败都降级为仅原句。
 * 去重（原句优先保留），空串过滤。
 */
export async function expandQueries(
  title: string,
  opts: { signal?: AbortSignal; timeoutMs?: number; deadlineAt?: number; context?: CallOptions<unknown>['context'] } = {},
): Promise<string[]> {
  const original = title.trim()
  if (!original) return []
  const out = [original]

  expandCounters.calls++
  const timeoutMs = opts.timeoutMs ?? EXPAND_TIMEOUT_DEFAULT_MS
  try {
    const r = await callAgent('expand', {
      messages: [
        { role: 'system', content: EXPAND_SYSTEM },
        { role: 'user', content: original },
      ],
      jsonMode: true,
      temperature: 0.7,
      timeoutMs,
      deadlineAt: Math.min(opts.deadlineAt ?? Infinity, Date.now() + timeoutMs),
      maxAttempts: 2,
      context: opts.context,
      signal: opts.signal,
      validate: (raw) => QueriesOut.parse(parseJsonLoose(raw)),
    })
    for (const q of r.content.slice(0, 3)) {
      const s = q.trim()
      if (s && !out.includes(s)) out.push(s)
    }
    log.info('expand.queries', { ...opts.context, count: out.length })
  } catch (e) {
    expandCounters.degraded++
    log.warn('expand.degraded', {
      ...opts.context,
      degradedTotal: expandCounters.degraded,
      reason: e instanceof Error ? e.message.slice(0, 160) : String(e).slice(0, 160),
    })
  }
  return out
}
