/** Regression test: all expanded Zhihu queries are issued concurrently. */
import assert from 'node:assert/strict'
import { mock } from 'bun:test'

let running = 0
let maxRunning = 0
const started: string[] = []

mock.module('./zhihu/client', () => ({
  search: async (query: string) => {
    started.push(query)
    running++
    maxRunning = Math.max(maxRunning, running)
    await new Promise((resolve) => setTimeout(resolve, 15))
    running--
    return [{ ContentID: query, Url: `https://www.zhihu.com/question/1/answer/${query}`, ContentText: query, Title: '题目' }]
  },
  isLive: () => true,
  normalizeAuthority: () => 0,
  questionIdFromUrl: () => '1',
  ZhihuError: class ZhihuError extends Error {},
  zhihuCounters: { search: 0, hotList: 0, quota: 0 },
}))

const { searchDedup } = await import('./agents/llm')
const controller = new AbortController()
const ctx: any = {
  qid: '1', date: '2026-01-01', signal: controller.signal,
  deadlineAt: Date.now() + 5_000, note() {}, report() {},
}
const out = await searchDedup(['原句', '问法一', '问法二', '问法三'], ctx)
assert.equal(started.length, 4)
assert.equal(maxRunning, 4, 'all query variants should be in flight together')
assert.equal(out.length, 4)
console.log('search concurrency tests passed')
