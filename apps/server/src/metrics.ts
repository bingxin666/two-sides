/**
 * 分歧度 —— 纯熵（docs/03 §4.3）
 *
 * H = -Σ pᵢ·ln pᵢ / ln 5，映射 low(<.35) / mid(<.55) / high(<.75) / extreme(≥.75)
 * 不掺任何评论权重：评论对分布的质疑走独立字段 commentChallengeCount，
 * 不污染这个描述统计量。
 */

import type { Divergence } from '@two-sides/contract'

export function entropy(counts: number[]): number {
  const total = counts.reduce((a, b) => a + b, 0)
  if (total <= 0) return 0
  let h = 0
  for (const c of counts) {
    if (c <= 0) continue
    const p = c / total
    h -= p * Math.log(p)
  }
  return h / Math.log(5)
}

/**
 * counts 长度固定 5（slot 1..5），未出现的档填 0。
 * participantCount === 1 时熵恒为 0 → 固定 low（§5.2 规则 7）。
 */
export function divergenceFromCounts(counts: number[]): Divergence {
  const h = entropy(counts)
  if (h < 0.35) return 'low'
  if (h < 0.55) return 'mid'
  if (h < 0.75) return 'high'
  return 'extreme'
}
