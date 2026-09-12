/**
 * D0 确定性 fake 实现 —— 不联网、不烧额度，产出符合契约的 Analysis
 *
 * 与真实实现的边界完全由 `agents/types.ts` 的 `PipelineAgents` 定义：
 * D1 只要照同一组签名写一个 `agents/llm.ts`，在 `createAgents()` 里换掉即可，
 * 本文件与 pipeline.ts 都不需要改。
 *
 * 确定性：同一 {date, qid} 永远产出同一份结果（种子 = hash(date:qid)），
 * 便于前端联调与回归比对。
 */

import type { Analysis, AuthorityLevel, Judgment, Slot } from '@two-sides/contract'
import { checkCountingRules } from '@two-sides/contract'
import { divergenceFromCounts } from '../metrics'
import { env } from '../env'
import {
  delay,
  PipelineError,
  type MergedJudgment,
  type OrientedJudgment,
  type PipelineAgents,
  type PipelineContext,
  type RawAnswer,
  type SummarizeResult,
} from './types'

/* ------------------------------ 确定性随机 ------------------------------ */

function hash32(s: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h >>> 0
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pickInt(rnd: () => number, min: number, max: number): number {
  return min + Math.floor(rnd() * (max - min + 1))
}

/* -------------------------------- 语料 -------------------------------- */

const NAMES = [
  '看山', '林间有风', '沉默的大多数', '半山月', '十月的海', '阿岚',
  '老周', '顾言之', '青柠不酸', '路过的甲', '一只鹿', '南巷猫',
  '不做判断的人', '陈小满', '多棱镜', '晚八点', '江上客', '木南',
  '数据说话', '旁观者清', '北岛', '半个专家', '柳三变', '雨田',
  '爱思考的鹅', '无名氏', '老张说事', '南山雾',
]

const AXES: Array<{ left: string; right: string }> = [
  { left: '完全支持', right: '明确反对' },
  { left: '制度优先', right: '个体优先' },
  { left: '当下就该做', right: '应当再等等' },
  { left: '收益更重要', right: '风险更重要' },
  { left: '相信经验', right: '相信数据' },
  { left: '严格管控', right: '充分放开' },
  { left: '长期价值', right: '短期效率' },
  { left: '情感优先', right: '理性优先' },
]

const TOPICS = [
  '这件事的代价被严重低估了',
  '现有做法在短期内仍是最优解',
  '把选择权交还给个体更合理',
  '风险被舆论放大了',
  '真正的瓶颈不在技术而在执行',
  '这套规则对新人并不友好',
  '长期看收益会超过成本',
  '公开透明比结果正确更重要',
  '这件事不该用同一把尺子衡量',
  '外部条件已经发生了根本变化',
  '现有激励结构是扭曲的',
  '被忽略的一方同样值得被听见',
  '问题不在能力而在意愿',
  '效率的提升会以公平为代价',
  '经验在这里会失效',
]

const REASONS = [
  '原话明确把后果归因于此',
  '原话用「但是」转折，落点在这一端',
  '原话给出的是条件式支持，但限定条件指向该档',
  '原话强调权衡后的取舍，落点偏这一侧',
  '原话只质疑方法不否定方向，归中间档',
  '原话以自身经历佐证，立场明确',
]

const QUOTES = [
  '我做过三年这个，实际落地远没有说的那么简单。',
  '数据我不否认，但样本本身就有偏差。',
  '说白了，成本是转嫁给了最没有话语权的人。',
  '支持，但必须先把边界划清楚，不然一定会走样。',
  '我倾向于再观察一段时间，现在下结论太早。',
  '这件事不能只看效率，公平同样是硬约束。',
  '经验告诉我，凡是「一步到位」的方案都要警惕。',
  '反对把问题道德化，它就是个资源分配问题。',
  '两边都有道理，关键是处在哪一阶段。',
  '我换个角度：如果把时间尺度拉到十年，结论会反过来。',
]

function nameAt(i: number): string {
  const base = NAMES[i % NAMES.length] ?? `答主${i}`
  const round = Math.floor(i / NAMES.length)
  return round === 0 ? base : `${base}·${round}`
}

/* ------------------------------ 世界构建 ------------------------------ */

interface World {
  question: string
  answers: RawAnswer[]
  judgments: OrientedJudgment[]
}

const worldCache = new Map<string, World>()

export function buildWorld(qid: string, date: string): World {
  const key = `${date}:${qid}`
  const cached = worldCache.get(key)
  if (cached) return cached
  const w = buildWorldUncached(qid, date)
  // 只缓存少量，避免长跑内存无界
  if (worldCache.size > 64) worldCache.clear()
  worldCache.set(key, w)
  return w
}

function buildWorldUncached(qid: string, date: string): World {
  const rnd = mulberry32(hash32(`${date}:${qid}`))

  const sampleCount = pickInt(rnd, 15, 25)
  const answers: RawAnswer[] = []
  for (let i = 0; i < sampleCount; i++) {
    const authority = (pickInt(rnd, 1, 4) as AuthorityLevel)
    answers.push({
      answerId: `a${i + 1}`,
      content: QUOTES[i % QUOTES.length] ?? '',
      authorName: nameAt(i),
      authorBadge: authority >= 3 ? '知乎答主' : undefined,
      authority,
      voteUp: pickInt(rnd, 12, 4800),
      // D0 假链接：占位即可，真实实现必须原样透传接口返回的 Url（带 UTM）
      url: `https://www.zhihu.com/question/${qid}/answer/${100000 + i}`,
      commentChallengeCount: rnd() < 0.3 ? pickInt(rnd, 1, 6) : undefined,
    })
  }

  const judgmentCount = pickInt(rnd, 10, 15)
  const judgments: OrientedJudgment[] = []
  for (let j = 0; j < judgmentCount; j++) {
    const axis = AXES[j % AXES.length]!
    const participantCount = pickInt(rnd, 3, 9)
    const slotCount = Math.min(5, pickInt(rnd, 2, 5))

    // 随机选出 slotCount 个不同档位
    const slots: Slot[] = []
    const pool: Slot[] = [1, 2, 3, 4, 5]
    for (let k = 0; k < slotCount; k++) {
      const idx = pickInt(rnd, 0, pool.length - 1)
      slots.push(pool[idx]!)
      pool.splice(idx, 1)
    }
    slots.sort((a, b) => a - b)

    // 把 participantCount 分到各档，每档至少 1
    const counts: number[] = new Array(slotCount).fill(1)
    let rest = participantCount - slotCount
    while (rest > 0) {
      const idx = pickInt(rnd, 0, slotCount - 1)
      counts[idx] = (counts[idx] ?? 0) + 1
      rest--
    }

    // 每档取不同答主：名字在同一判断内唯一（§5.2 规则 1）
    const bySlot = new Map<Slot, number[]>()
    let cursor = hash32(`${qid}:${j}`) % answers.length
    for (let k = 0; k < slotCount; k++) {
      const ids: number[] = []
      for (let n = 0; n < counts[k]!; n++) {
        ids.push(cursor % answers.length)
        cursor = (cursor + 1) % answers.length
      }
      bySlot.set(slots[k]!, ids)
    }

    // 用 Set 去重（跨档也不能重复同一个人）
    const used = new Set<number>()
    for (const [, ids] of bySlot) {
      for (let n = 0; n < ids.length; n++) {
        let id = ids[n]!
        let guard = 0
        while (used.has(id) && guard++ < answers.length) {
          id = (id + 1) % answers.length
        }
        used.add(id)
        ids[n] = id
      }
    }

    const distribution: Judgment['distribution'] = []
    const authorityDistribution = [0, 0, 0, 0, 0]
    for (const slot of slots) {
      const ids = bySlot.get(slot) ?? []
      if (ids.length === 0) continue // 空档不出现（规则 4）
      const authors = ids.map((id) => {
        const a = answers[id]!
        if (a.authority >= 3) {
          authorityDistribution[slot - 1] = (authorityDistribution[slot - 1] ?? 0) + 1
        }
        return {
          name: a.authorName,
          badge: a.authorBadge,
          authority: a.authority,
          quote: QUOTES[(id + j) % QUOTES.length] ?? '',
          url: a.url,
          reason: REASONS[(id + j) % REASONS.length] ?? '',
          voteUp: a.voteUp,
        }
      })
      distribution.push({ slot, authors })
    }

    const finalParticipant = distribution.reduce((n, b) => n + b.authors.length, 0)
    const slotCounts = [0, 0, 0, 0, 0]
    for (const b of distribution) slotCounts[b.slot - 1] = b.authors.length

    const partial = rnd() < 0.15
    const judgment: OrientedJudgment = {
      id: `j${j + 1}`,
      text: TOPICS[j % TOPICS.length] ?? `议题 ${j + 1}`,
      participantCount: finalParticipant,
      divergence: divergenceFromCounts(slotCounts),
      commentChallengeCount: rnd() < 0.35 ? pickInt(rnd, 1, 8) : undefined,
      orientStatus: partial ? 'partial' : 'done',
      semanticAxis: { left: axis.left, right: axis.right },
      scaleDirection: 'left_to_right',
      distribution,
      authorityDistribution,
      relatedAnswerIds: [...used].map((id) => answers[id]!.answerId),
    }
    // 规则 7：participantCount === 1 时 divergence 固定 low
    if (judgment.participantCount === 1) judgment.divergence = 'low'
    judgments.push(judgment)
  }

  return {
    question: `问题 ${qid}（fake 数据 · D0）`,
    answers,
    judgments,
  }
}

/* --------------------------- 确定性快照生成 --------------------------- */

/** 直接产出 Analysis（seed 脚本与测试用，不带进度与延迟） */
export function generateFakeAnalysis(qid: string, date: string, withSummary = true): Analysis {
  const w = buildWorld(qid, date)
  const analysis: Analysis = {
    qid,
    question: w.question,
    date,
    sampleCount: w.answers.length,
    judgments: w.judgments.map<Judgment>((j) => {
      const { relatedAnswerIds: _drop, ...rest } = j
      return rest
    }),
  }
  if (withSummary) {
    for (const j of analysis.judgments) {
      j.summary =
        `在「${j.semanticAxis.left}—${j.semanticAxis.right}」这条轴上，${j.participantCount} 人表态，分歧度${j.divergence}。`
      // D0 没有真实直答，来源标注 fallback，前端按来源双态展示
      j.summarySource = 'fallback'
    }
  }
  const errs = checkCountingRules(analysis)
  if (errs.length) {
    // fake 生成器自己都不合规就是 bug，直接暴露出来而不是写脏数据
    throw new PipelineError(`fake data violates counting rules: ${errs[0]}`, 'parse_error', 'render', false)
  }
  return analysis
}

/* ------------------------------ Agent 实现 ------------------------------ */

export interface FakeAgentsOptions {
  /** 单步耗时（毫秒）。缺省时按 PIPELINE_FAKE_DURATION_MS 均摊到各步 */
  stepMs?: number
}

export function createFakeAgents(opts: FakeAgentsOptions = {}): PipelineAgents {
  /** 每步耗时；fetchAnswers 知道总步数后会把它算准 */
  let stepMs = opts.stepMs ?? 400
  let timed = opts.stepMs !== undefined

  const step = async (ctx: PipelineContext) => {
    if (!stepMs) return
    await delay(stepMs, ctx.signal)
    if (ctx.signal.aborted) throw new PipelineError('aborted', 'timeout', 'extract', true)
  }

  return {
    async fetchAnswers(qid, ctx) {
      const w = buildWorld(qid, ctx.date)
      if (!timed) {
        timed = true
        // 按「并发轮数」而不是调用次数估算总时长：默认提取 30、取向 100
        const extractRounds = Math.ceil(Math.ceil(w.answers.length / 4) / 30)
        const orientRounds = Math.ceil(w.judgments.length / 100)
        const steps = 1 + extractRounds + 1 + orientRounds + 1
        stepMs = Math.max(0, Math.round(env.PIPELINE_FAKE_DURATION_MS / steps))
      }
      await step(ctx)
      ctx.report({ stage: 'extract', stageRatio: 0, sampleCount: w.answers.length, judgmentsDone: 0, judgmentsTotal: w.judgments.length })
      return { question: w.question, answers: w.answers }
    },

    async extract(batch, ctx) {
      await step(ctx)
      const w = buildWorld(ctx.qid, ctx.date)
      const ids = new Set(batch.map((a) => a.answerId))
      // fake：每批贡献 1–2 条判断（真实实现由模型产出）
      const take = 1 + (batch.length % 2)
      const out = w.judgments
        .filter((j) => j.relatedAnswerIds.some((id) => ids.has(id)))
        .slice(0, take)
        .map((j) => ({
          text: j.text,
          quote: j.distribution[0]?.authors[0]?.quote ?? '',
          answerId: j.relatedAnswerIds[0] ?? 'a1',
        }))
      return out
    },

    async merge(items, ctx) {
      await step(ctx)
      const w = buildWorld(ctx.qid, ctx.date)
      if (items.length === 0) return []
      const out: MergedJudgment[] = w.judgments
        .map<MergedJudgment>((j) => ({
          id: j.id,
          text: j.text,
          sourceQuotes: j.distribution.flatMap((b) => b.authors.map((a) => a.quote)).slice(0, 3),
          answerIds: j.relatedAnswerIds,
          commentChallengeCount: j.commentChallengeCount,
        }))
      ctx.report({ stage: 'merge', stageRatio: 1, judgmentsTotal: out.length })
      return out
    },

    async orient(judgment, _answers, ctx) {
      await step(ctx)
      const w = buildWorld(ctx.qid, ctx.date)
      const hit = w.judgments.find((j) => j.id === judgment.id)
      return hit ?? null
    },

    async summarize(_answers, _judgments, ctx): Promise<SummarizeResult> {
      await step(ctx)
      ctx.report({ stage: 'render', stageRatio: 0.9 })
      return {
        summary: '（D0 fake 综述）两侧都能找到认真作答的人，分歧本身比结论更值得看。',
        // D0 无真实调用，标注 fallback 来源（前端按来源双态展示）
        source: 'fallback',
      }
    },
  }
}
