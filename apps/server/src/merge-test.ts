/** Deterministic regression checks for merge attribution and orphan preservation. */
import assert from 'node:assert/strict'
import { normalizeMergedJudgments } from './agents/llm'
import type { ExtractedJudgment } from './agents/types'

const items: ExtractedJudgment[] = [
  { answerId: 'a1', text: '成本下降会扩大普及', quote: '成本下降会扩大普及。' },
  { answerId: 'a1', text: '但短期会增加维护压力', quote: '但短期会增加维护压力。' },
  { answerId: 'a2', text: '应优先解决安全问题', quote: '应优先解决安全问题。' },
]

const result = normalizeMergedJudgments(items, [
  // sourceQuotes 足以恢复来源，且保留同一回答的第一个细分判断。
  { text: '成本下降会扩大普及', sourceQuotes: ['成本下降会扩大普及。'] },
  // 无法追溯的模型幻觉必须丢弃。
  { text: '模型凭空生成的观点', answerIds: ['unknown'] },
], 3, 5)

assert.equal(result.length, 3)
assert.equal(result[0]?.answerIds[0], 'a1')
assert.equal(result[0]?.text, '成本下降会扩大普及')
assert.deepEqual(result.slice(1).map((j) => j.text), [
  '但短期会增加维护压力',
  '应优先解决安全问题',
])
assert.deepEqual(result.slice(1).map((j) => j.answerIds[0]), ['a1', 'a2'])
assert.equal(result.filter((j) => j.text.includes('凭空')).length, 0)

// 同一原话出现在不同回答时，显式 answerIds 约束只能归属指定来源。
const ambiguous: ExtractedJudgment[] = [
  { answerId: 'x1', text: '值得尝试', quote: '值得尝试。' },
  { answerId: 'x2', text: '也值得尝试', quote: '值得尝试。' },
]
const constrained = normalizeMergedJudgments(ambiguous, [
  { text: '值得尝试', sourceQuotes: ['值得尝试。'], answerIds: ['x2'] },
], 5, 5)
assert.equal(constrained[0]?.answerIds[0], 'x2')
assert.equal(constrained.some((j) => j.text === '值得尝试' && j.answerIds[0] === 'x1'), true)

// 归并模型只在 factionGroups 填来源时，仍应提升到 judgment 级别并保留。
const groupedOnly = normalizeMergedJudgments(items, [
  {
    text: '成本变化是否会影响普及',
    factionGroups: [
      { label: '支持扩大普及', answerIds: ['a1'], sourceQuotes: ['成本下降会扩大普及。'] },
    ],
  },
], 5, 5)
assert.equal(groupedOnly[0]?.answerIds.includes('a1'), true)
assert.equal(groupedOnly[0]?.sourceQuotes.includes('成本下降会扩大普及。'), true)

console.log('merge attribution tests passed')
