/** Offline contract tests for the two-pass topic/classification agents. */
import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const oldCwd = process.cwd()
const dir = mkdtempSync(join(resolve(tmpdir()), 'two-sides-two-pass-'))
writeFileSync(join(dir, '.env'), '')
process.chdir(dir)
const calls: Array<{ agent: string; payload: any; maxTokens?: number; system?: string }> = []
let mode: 'discover' | 'classify' = 'discover'
mock.module('./llm', () => ({ createLlmAgents: () => ({
  fetchAnswers: async () => ({ question: '', answers: [] }), extract: async () => [], merge: async () => [],
  orient: async () => null, summarize: async () => ({}),
}) }))
mock.module('../llm/provider', () => ({
  callAgent: async (agent: string, opts: any) => {
    const payload = JSON.parse(opts.messages[1].content)
    calls.push({ agent, payload, maxTokens: opts.maxTokens, system: opts.messages[0].content })
    const out = mode === 'discover'
      ? { topics: [
        { text: '成本是否值得', semanticAxis: { left: '成本过高', right: '收益足够', }, evidence: [{ answerId: 'a1', quote: '成本值得投入。' }] },
        { text: '安全是否优先', semanticAxis: { left: '安全优先', right: '效率优先', }, evidence: [{ answerId: 'a2', quote: '安全问题必须优先。' }] },
        { text: '伪造主题', semanticAxis: { left: '同一', right: '同一' }, evidence: [{ answerId: 'x', quote: '不存在' }] },
      ] }
      : { placements: payload.answer.answerId === 'a1' ? [
        { topicId: 'j1', slot: 5, quote: '成本值得投入。', reason: '回答明确认为收益足够覆盖成本' },
        { topicId: 'j1', slot: 1, quote: '成本值得投入。', reason: '冲突行应被拒绝' },
        { topicId: 'unknown', slot: 3, quote: '成本值得投入。', reason: '未知主题' },
        { topicId: 'j2', slot: 3, quote: '伪造引文', reason: '引文不在原文' },
      ] : [] }
    let content: unknown
    try { content = opts.validate(JSON.stringify(out)) }
    catch (error) { const wrapped: any = new Error(String(error)); wrapped.kind = 'parse'; throw wrapped }
    return { content, raw: JSON.stringify(out), latencyMs: 1, attempts: 1, rateLimitWaitMs: 0, usage: { totalTokens: 1 }, model: 'test' }
  },
}))

try {
  const { createTwoPassAgents } = await import('./two-pass')
  const ctx: any = { qid: 'q', date: '2026-01-01', signal: new AbortController().signal, deadlineAt: Date.now() + 30_000, report() {}, note() {} }
  const answers: any[] = [
    { answerId: 'a1', content: '成本值得投入。', authorName: 'A', authority: 1, voteUp: 1, url: '' },
    { answerId: 'a2', content: '安全问题必须优先。', authorName: 'B', authority: 1, voteUp: 1, url: '' },
    { answerId: 'a3', content: '没有明确观点。', authorName: 'C', authority: 1, voteUp: 1, url: '' },
  ]
  const agents = createTwoPassAgents()
  const topics = await agents.discoverTopics!("测试题", answers, ctx)
  assert.deepEqual(topics.map((topic) => topic.id), ['j1', 'j2'])
  // 主题发现要一次吃下整个样本池（2026-09-13 起 ≤4 路检索去重、≤40 条回答）
  assert.equal(calls[0]!.maxTokens, 12_000)
  assert.match(calls[0]!.system!, /8 个是硬上限/)
  assert.equal(calls[0]!.payload.answers.length, answers.length)
  assert.equal(calls[0]!.payload.answers[0].content, answers[0].content)
  mode = 'classify'
  await assert.rejects(
    () => agents.classifyAnswer!(topics, answers[0], ctx),
    (error: any) => error?.mapped === 'parse_error',
    'all invalid/conflicting rows are not an explicit unmatched result',
  )
  const unmatched = await agents.classifyAnswer!(topics, answers[2], ctx)
  assert.deepEqual(unmatched, { answerId: 'a3', placements: [] })
  assert.equal(calls.filter((call) => call.agent === 'orient').length, 2)
  assert.equal(calls.find((call) => call.agent === 'orient')!.maxTokens, 3_000)
  console.log('two-pass tests passed')
} finally {
  process.chdir(oldCwd)
  rmSync(resolve(dir), { recursive: true, force: true })
}
