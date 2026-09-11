/**
 * 全局令牌桶（LLM_RPM_LIMIT，默认 60 req/min）
 *
 * docs/03 §3.1：管线共享，防打爆 LLM 与知乎限频。
 * 实现：容量 = rpm（允许短时突发一整分钟的量），恒定补充速率 rpm/60 每秒。
 */

import { env } from './env'

export class TokenBucket {
  private tokens: number
  private lastRefill: number

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
  ) {
    this.tokens = capacity
    this.lastRefill = Date.now()
  }

  /** rpm → 桶 */
  static perMinute(rpm: number): TokenBucket {
    const cap = Math.max(1, rpm)
    return new TokenBucket(cap, cap / 60)
  }

  private refill(now = Date.now()): void {
    const elapsed = Math.max(0, now - this.lastRefill) / 1000
    if (elapsed <= 0) return
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSec)
    this.lastRefill = now
  }

  /** 同步尝试取 token，取不到返回 false（不等待） */
  tryTake(cost = 1): boolean {
    this.refill()
    if (this.tokens >= cost) {
      this.tokens -= cost
      return true
    }
    return false
  }

  /** 等到取到 token 为止；返回实际等待毫秒 */
  async take(cost = 1): Promise<number> {
    const start = Date.now()
    for (;;) {
      this.refill()
      if (this.tokens >= cost) {
        this.tokens -= cost
        return Date.now() - start
      }
      const deficit = cost - this.tokens
      const waitMs = Math.max(10, Math.ceil((deficit / this.refillPerSec) * 1000))
      await new Promise<void>((r) => setTimeout(r, waitMs))
    }
  }

  /** 当前可用 token 数（观测用） */
  available(): number {
    this.refill()
    return Math.floor(this.tokens)
  }
}

/** LLM 全局桶：进程内所有 Agent 共享 */
export const llmBucket = TokenBucket.perMinute(env.LLM_RPM_LIMIT)
