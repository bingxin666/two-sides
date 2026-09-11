#!/usr/bin/env node
/**
 * Fixture 校验 —— 契约漂移会让前端白屏，这一步不许跳过。
 *
 * 用法：
 *   node scripts/validate-fixtures.mjs          # 只校验，有违规则 exit 1
 *   node scripts/validate-fixtures.mjs --fix    # 先按口径重算派生字段，再校验
 *
 * 派生字段（由 distribution 唯一决定，手写必错）：
 *   participantCount      = Σ distribution[].authors.length
 *   divergence            = 五档计数归一化香农熵的映射（见后端文档 §4.3）
 *   authorityDistribution = 本判断内每个 slot 上 L3–L4 答主人数，长度固定 5
 *
 * 依赖：直接吃 packages/contract 的 zod schema 与 checkCountingRules()，
 * 不复制任何契约结构（Node 22 原生 TS 类型剥离）。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import {
  Analysis,
  HotResp,
  ProgressResp,
  ErrorCode,
  checkCountingRules,
} from '../../../packages/contract/src/index.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIX_DIR = path.join(HERE, '..', 'src', 'mock', 'fixtures')

const ANALYSIS_FILES = ['analysis-kaoyan.json', 'analysis-house.json']
const HOT_FILE = 'hot.json'
const TIMELINE_FILE = 'progress-timeline.json'

const FIX = process.argv.includes('--fix')

/* ---------------- 派生字段计算 ---------------- */

/** 五档计数 → 分歧度（纯熵，后端文档 §4.3） */
function divergenceOf(counts) {
  const total = counts.reduce((a, b) => a + b, 0)
  if (total <= 1) return 'low'
  let h = 0
  for (const c of counts) {
    if (!c) continue
    const p = c / total
    h -= p * Math.log(p)
  }
  h /= Math.log(5)
  if (h < 0.35) return 'low'
  if (h < 0.55) return 'mid'
  if (h < 0.75) return 'high'
  return 'extreme'
}

function countsOf(judgment) {
  const counts = [0, 0, 0, 0, 0]
  for (const bucket of judgment.distribution) counts[bucket.slot - 1] = bucket.authors.length
  return counts
}

function authorityOf(judgment) {
  const out = [0, 0, 0, 0, 0]
  for (const bucket of judgment.distribution) {
    out[bucket.slot - 1] = bucket.authors.filter((a) => a.authority >= 3).length
  }
  return out
}

function normalize(analysis) {
  for (const j of analysis.judgments) {
    j.participantCount = j.distribution.reduce((n, b) => n + b.authors.length, 0)
    j.divergence = divergenceOf(countsOf(j))
    j.authorityDistribution = authorityOf(j)
    j.distribution.sort((a, b) => a.slot - b.slot)
  }
  return analysis
}

/* ---------------- 收集违规 ---------------- */

const violations = []
const notes = []

function readJson(name) {
  const file = path.join(FIX_DIR, name)
  return { file, json: JSON.parse(readFileSync(file, 'utf8')) }
}

/** 契约之外的「像不像真的」检查，只提示不拦截 */
function checkRealism(name, analysis) {
  const seenId = new Set()
  for (const j of analysis.judgments) {
    if (seenId.has(j.id)) violations.push(`${name} [${j.id}] judgment id 重复`)
    seenId.add(j.id)

    const all = j.distribution.flatMap((b) => b.authors)
    for (const a of all) {
      const len = [...a.quote].length
      if (len < 10 || len > 40) {
        violations.push(`${name} [${j.id}] 答主「${a.name}」quote 长度 ${len}，要求 10–40 字`)
      }
      if (!a.reason || !a.reason.trim()) {
        violations.push(`${name} [${j.id}] 答主「${a.name}」缺少归位理由 reason`)
      }
      if (!/^https:\/\/www\.zhihu\.com\/question\/\d+\/answer\/\d+\?/.test(a.url)) {
        violations.push(`${name} [${j.id}] 答主「${a.name}」url 形态不符合知乎原链（应带溯源参数）`)
      }
    }
    const authoritySet = new Set(all.map((a) => a.authority))
    if (authoritySet.size < 2) {
      notes.push(`${name} [${j.id}] authority 只有 ${[...authoritySet].join('/')} 一档，分布不够真实`)
    }
  }
  const div = new Set(analysis.judgments.map((j) => j.divergence))
  notes.push(`${name} 分歧度覆盖：${[...div].sort().join(' / ')}`)
}

/* ---------------- 主流程 ---------------- */

// 1) hot
{
  const { file, json } = readJson(HOT_FILE)
  const parsed = HotResp.safeParse(json)
  if (!parsed.success) {
    violations.push(`${HOT_FILE} 未通过 HotResp: ${parsed.error.issues.map((i) => `${i.path.join('.')}:${i.message}`).join('; ')}`)
  } else {
    if (parsed.data.items.length < 20) {
      violations.push(`${HOT_FILE} 只有 ${parsed.data.items.length} 条，要求 20+`)
    }
    const qids = parsed.data.items.map((i) => i.qid)
    if (new Set(qids).size !== qids.length) violations.push(`${HOT_FILE} 存在重复 qid`)
    notes.push(`${HOT_FILE}: ${parsed.data.items.length} 条，date=${parsed.data.date}`)
  }
  void file
}

// 2) analyses
const readyQids = []
for (const name of ANALYSIS_FILES) {
  const { file, json } = readJson(name)

  if (FIX) {
    writeFileSync(file, `${JSON.stringify(normalize(json), null, 2)}\n`, 'utf8')
    notes.push(`${name}: 已按口径重算 participantCount / divergence / authorityDistribution`)
  }

  const parsed = Analysis.safeParse(json)
  if (!parsed.success) {
    violations.push(
      `${name} 未通过 Analysis: ${parsed.error.issues.map((i) => `${i.path.join('.')}:${i.message}`).join('; ')}`,
    )
    continue
  }
  const analysis = parsed.data
  readyQids.push(analysis.qid)

  for (const err of checkCountingRules(analysis)) violations.push(`${name} ${err}`)

  const n = analysis.judgments.length
  if (n < 10 || n > 15) violations.push(`${name} judgments ${n} 条，契约要求 10–15 条`)

  for (const j of analysis.judgments) {
    const expectedDiv = divergenceOf(countsOf(j))
    if (j.divergence !== expectedDiv) {
      violations.push(`${name} [${j.id}] divergence=${j.divergence}，按熵应为 ${expectedDiv}`)
    }
    const expectedAuth = authorityOf(j)
    if (j.authorityDistribution.join(',') !== expectedAuth.join(',')) {
      violations.push(
        `${name} [${j.id}] authorityDistribution=[${j.authorityDistribution}]，应为 [${expectedAuth}]`,
      )
    }
    const slots = j.distribution.map((b) => b.slot)
    if (new Set(slots).size !== slots.length) violations.push(`${name} [${j.id}] distribution 存在重复 slot`)
    if (slots.join(',') !== [...slots].sort((a, b) => a - b).join(',')) {
      violations.push(`${name} [${j.id}] distribution 未按 slot 升序`)
    }
    if (j.participantCount > analysis.sampleCount) {
      violations.push(`${name} [${j.id}] participantCount ${j.participantCount} > sampleCount ${analysis.sampleCount}`)
    }
  }

  checkRealism(name, analysis)
  notes.push(
    `${name}: ${n} 条判断，sampleCount=${analysis.sampleCount}，qid=${analysis.qid}，「${analysis.question}」`,
  )
}

// 3) progress timeline
{
  const { json } = readJson(TIMELINE_FILE)
  const parsed = ProgressResp.array().safeParse(json)
  if (!parsed.success) {
    violations.push(
      `${TIMELINE_FILE} 未通过 ProgressResp[]: ${parsed.error.issues.map((i) => `${i.path.join('.')}:${i.message}`).join('; ')}`,
    )
  } else {
    const stages = parsed.data.map((p) => `${p.status}:${p.stage}`)
    const covered = new Set(parsed.data.map((p) => p.stage))
    for (const s of ['extract', 'merge', 'orient', 'render']) {
      if (!covered.has(s)) violations.push(`${TIMELINE_FILE} 缺少阶段 ${s}`)
    }
    notes.push(`${TIMELINE_FILE}: ${parsed.data.length} 帧 → ${stages.join(' → ')}`)
  }
}

// 4) 强制失败分支用到的 ErrorCode 必须合法
for (const code of ['quota_exhausted', 'zhihu_error', 'llm_error', 'timeout', 'parse_error']) {
  if (!ErrorCode.safeParse(code).success) violations.push(`mock 失败分支用到非法 ErrorCode: ${code}`)
}

/* ---------------- 输出 ---------------- */

for (const note of notes) console.log(`· ${note}`)
console.log('')

if (violations.length === 0) {
  console.log(`✅ 全部 fixture 通过契约校验（0 违规），已 ready 的 qid：${readyQids.join(', ')}`)
  process.exit(0)
}

console.log(`❌ ${violations.length} 条违规：`)
for (const v of violations) console.log(`  - ${v}`)
process.exit(1)
