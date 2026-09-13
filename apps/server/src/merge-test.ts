/** Deterministic regression checks; run with bun --no-env-file to isolate dotenv. */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type { ExtractedJudgment } from './agents/types'

const previousCwd = process.cwd()
const scratchRoot = resolve(tmpdir())
const scratch = mkdtempSync(join(scratchRoot, 'two-sides-merge-test-'))
try {
  // env.ts explicitly walks upwards for .env; an empty local file stops that walk.
  writeFileSync(join(scratch, '.env'), '')
  process.chdir(scratch)
  const { normalizeMergedJudgments, normalizeSourceMergedJudgments } = await import('./agents/llm')

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

// Compact references restore exact sources and retain an omitted view by the same author.
const compact = normalizeSourceMergedJudgments(items, [{
  text: '普及和安全应如何取舍',
  sourceIds: ['x1', 'x1', 'unknown', 'x0', 'x01', ' x2 '],
  factionGroups: [
    { label: '降低门槛', sourceIds: ['x1', 'x1', 'unknown'] },
    { label: '优先安全', sourceIds: ['x3', 'x3'] },
    { label: '凭空派系', sourceIds: ['x99'] },
  ],
}], 5, 5)
assert.deepEqual(compact[0]?.answerIds, ['a1', 'a2'])
assert.deepEqual(compact[0]?.sourceQuotes, [items[0]!.quote, items[2]!.quote])
assert.deepEqual(compact[0]?.factionHints, ['降低门槛', '优先安全'])
assert.deepEqual(compact[0]?.factionGroups, [
  { label: '降低门槛', answerIds: ['a1'], sourceQuotes: [items[0]!.quote] },
  { label: '优先安全', answerIds: ['a2'], sourceQuotes: [items[2]!.quote] },
])
assert.deepEqual(compact.slice(1).map((j) => [j.text, j.answerIds]), [
  [items[1]!.text, ['a1']],
])

// Identical quotes across authors are never expanded to an unreferenced source.
const exactAmbiguous = normalizeSourceMergedJudgments(ambiguous, [{
  text: '这是否值得尝试',
  factionGroups: [{ label: '值得尝试', sourceIds: ['x2'] }],
}], 5, 5)
assert.deepEqual(exactAmbiguous[0]?.answerIds, ['x2'])
assert.deepEqual(exactAmbiguous[0]?.factionGroups?.[0]?.answerIds, ['x2'])
assert.deepEqual(exactAmbiguous.slice(1).map((j) => [j.text, j.answerIds]), [
  [ambiguous[0]!.text, ['x1']],
])

// An exact extraction ID also disambiguates multiple views sharing one author's quote.
const sameAnswerQuote: ExtractedJudgment[] = [
  { answerId: 'a1', text: '值得尝试但应关注风险', quote: '值得尝试，但应关注风险。' },
  { answerId: 'a1', text: '风险约束不能忽略', quote: '值得尝试，但应关注风险。', factionHint: '关注风险' },
]
const exactView = normalizeSourceMergedJudgments(sameAnswerQuote, [{
  text: '是否应当尝试', sourceIds: ['x1'],
}], 5, 5)
assert.equal(exactView[1]?.text, sameAnswerQuote[1]!.text)
assert.deepEqual(exactView[1]?.factionHints, ['关注风险'])

// Group-only output is sufficient; duplicate labels accumulate their own references.
const compactGroups = normalizeSourceMergedJudgments(items, [{
  text: '成本变化与普及有什么关系',
  factionGroups: [
    { label: ' 成本影响 ', sourceIds: ['x1'] },
    { label: '成本影响', sourceIds: ['x2', 'x1'] },
    { label: ' ', sourceIds: ['x3'] },
  ],
}], 5, 5)
assert.deepEqual(compactGroups[0]?.factionGroups, [{
  label: '成本影响', answerIds: ['a1'], sourceQuotes: [items[0]!.quote, items[1]!.quote],
}])
assert.equal(compactGroups[1]?.text, items[2]!.text)

// Fabricated or missing references cannot validate model claims; original views survive.
const compactInvalid = normalizeSourceMergedJudgments(items, [
  { text: '模型凭空生成的观点', sourceIds: ['a1', 'x999'] },
  { text: '模型没有交代的来源' },
], 5, 5)
assert.deepEqual(compactInvalid.map((j) => j.text), items.map((item) => item.text))
assert.equal(compactInvalid.every((j) => j.id.startsWith('jfallback')), true)

// The normalizer preserves the public judgment cap and the existing fallback budget.
assert.equal(normalizeSourceMergedJudgments(items, [], 2, 5).length, 2)
assert.equal(normalizeSourceMergedJudgments(items, [], 5, 1).length, 1)

console.log('merge attribution tests passed')
} finally {
  process.chdir(previousCwd)
  // Check the exact mkdtemp target before recursive cleanup, including on Windows.
  const cleanupTarget = resolve(scratch)
  if (dirname(cleanupTarget) !== scratchRoot || !basename(cleanupTarget).startsWith('two-sides-merge-test-')) {
    throw new Error('refusing to clean an unexpected merge-test directory')
  }
  rmSync(cleanupTarget, { recursive: true, force: true })
}
