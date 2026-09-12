/**
 * D1 真实 Agent 实现 —— 与 agents/fake.ts 同一组 PipelineAgents 签名
 *
 * 四阶段照 docs/03 §4：
 *   01 extract  批量化：一次调用吃 3–5 条回答（成本 1/3 的关键），信号量 4 在 pipeline.ts
 *   02 merge    单路串行，语义聚类去重
 *   03 orient   每判断一路，令牌桶 + 信号量 6 约束
 *   04 summarize 题级一次：zhida 优先，30002 → quota_exhausted → 降级外部 LLM（可观测）
 *
 * prompt 硬约束写死在模板里（docs/03 §4.2），结构化输出全部 zod 校验；
 * 解析失败重试预算耗尽 → parse_error（经 PipelineError 透传给 pipeline.ts 归类）。
 *
 * 凭证安全：所有密钥只在 provider/zhida 模块内部进 Authorization 头，本文件拿不到值。
 */

import { z } from 'zod'
import { callAgent } from '../llm/provider'
import { llmCounters, type ChatMessage } from '../llm/client'
import { ZhidaError, zhidaChat, zhidaCounters } from '../llm/zhida'
import { log } from '../log'
import { isLive, normalizeAuthority, questionIdFromUrl, search, ZhihuError, zhihuCounters, type ZhihuItem } from '../zhihu/client'
import { resolveQuestionTitle, rememberHint } from '../zhihu/title'
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
import { divergenceFromCounts } from '../metrics'
import type { Slot } from '@two-sides/contract'

/* ------------------------------- 常量 ------------------------------- */

/** 单条回答喂给模型的正文上限：长回答截断（docs/03 §8.3 风险项） */
const CONTENT_LIMIT = 1500
/** 内容池最少保留的回答正文长度，太短的不进池（无法定位原话） */
const MIN_CONTENT_LEN = 12
/** 预生成 30 题 × ~12 判断 ≈ 直答 30 次/日（docs/01 §8 第 7 条），综述必须题级一次 */
const SUMMARY_MAX_LEN = 400

/* --------------------------- JSON 宽松解析 --------------------------- */

/** 模型偶尔会用 ```json 围栏，剥掉再 parse */
function parseJsonLoose(raw: string): unknown {
  const trimmed = raw.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed)
  const body = fenced?.[1] ?? trimmed
  const start = body.search(/[[{]/)
  const json = start > 0 ? body.slice(start) : body
  return JSON.parse(json)
}

/* ------------------------------ 内容获取 ------------------------------ */

const SlotSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
]) satisfies z.ZodType<Slot>

function answerIdFromUrl(url: string): string | null {
  const m = /answer\/(\d+)/.exec(url)
  return m?.[1] ?? null
}

function truncate(s: string, max: number): string {
  const t = s.trim()
  return t.length <= max ? t : `${t.slice(0, max)}…`
}

/**
 * 8 个 Query 变体（2026-09-12 拍板：3→5→8，8 是终点不再扩）。
 * 方向（team-lead 指定）：原句 / 核心争议改写 / 对立面改写 / 下属具体场景 /
 * 泛化措辞 / 数字对比类 / 极端个案类 / 相关人群类 —— 后三个是对「模糊搜索
 * 带进外题」的对冲：更精确的措辞会提高本题命中率（配合 fetchAnswers 的
 * URL 强校验兜底）。
 * 8/题 × 30 题 = 240 次/日，预生成预算内（额度实测 4965/5000）。
 * 单次 Count 上限 10，靠变体扩容后按 answerId 去重合并。
 */
function buildVariants(question: string): string[] {
  const t = question.trim()
  if (!t) return []
  // 泛化措辞的机械实现：取首个标点前的短段（问句的细化尾巴常是外题漂移源）
  const general = t.split(/[，,。？?！!、]/, 1)[0]?.trim() ?? ''
  const candidates = [
    t, // 原句
    `${t} 争议`, // 核心争议改写
    `${t} 反对`, // 对立面改写：把反方一侧的内容拉进内容池
    `${t} 场景`, // 下属具体场景
    general, // 泛化措辞
    `${t} 数据`, // 数字对比类
    `${t} 个案`, // 极端个案类
    `${t} 专家`, // 相关人群类
  ]
  // 去重去空；泛化段/短问句可能过短，不足 8 字不单独成查询（防全网漂移）
  const out: string[] = []
  for (const v of candidates) {
    const s = v.trim()
    if (s.length >= 8 && !out.includes(s)) out.push(s)
  }
  return out.length > 0 ? out : [t]
}

function toRawAnswer(it: ZhihuItem): RawAnswer | null {
  const url = (it.Url ?? '').trim()
  // 实测搜索结果自带 ContentID（String），Url 里的 answer id 作为兜底
  const answerId = (it.ContentID ?? '').trim() || answerIdFromUrl(url)
  if (!answerId) return null // 只收回答，专栏文章不计入（docs/03 §5.2 sampleCount 口径）
  const content = (it.ContentText ?? '').trim()
  if (content.length < MIN_CONTENT_LEN) return null
  return {
    answerId,
    content,
    authorName: (it.AuthorName ?? '').trim() || `知乎答主 ${answerId.slice(-4)}`,
    authorBadge: it.AuthorBadgeText?.trim() || undefined,
    authority: normalizeAuthority(it.AuthorityLevel),
    voteUp: Number.isFinite(Number(it.VoteUpCount))
      ? Math.max(0, Math.trunc(Number(it.VoteUpCount)))
      : 0,
    url,
    // 实测搜索结果只有 CommentCount（评论总数），没有评论内容，
    // 无法按口径统计「提出不同看法的精选评论条数」—— 该字段暂不产出（待产品确认口径）
    commentChallengeCount: undefined,
  }
}

async function searchDedup(variants: string[], ctx: PipelineContext): Promise<ZhihuItem[]> {
  const seen = new Map<string, ZhihuItem>()
  for (let i = 0; i < variants.length; i++) {
    const v = variants[i]!
    try {
      // Count 上限 10：服务端 >10 截断、<=0 回退 10，这里显式传 10
      const items = await search(v, 10)
      for (const it of items) {
        const key = (it.ContentID ?? '').trim() || answerIdFromUrl(it.Url ?? '') || (it.Url ?? '').trim()
        if (!key || seen.has(key)) continue
        seen.set(key, it)
      }
      ctx.note(`search.variant.${i}.ok`, { queryLen: v.length, got: items.length })
    } catch (e) {
      // 单变体失败不阻塞其余变体（≥1 个变体成功即可继续）
      const err = e instanceof ZhihuError ? e : null
      ctx.note(`search.variant.${i}.failed`, { kind: err?.errorCode ?? 'unknown' })
      if (i === variants.length - 1 && seen.size === 0) throw e
    }
    // 变体间隔（2026-09-12 team-lead 批准）：run1 曾出现单变体 30001 频率限制，
    // 200–400ms 错峰可显著降低概率，D2 预生成沿用
    if (i < variants.length - 1) await delay(300, ctx.signal)
  }
  return [...seen.values()]
}

/* ---------------------------- 01 提取 Agent ---------------------------- */

const ExtractOut = z.object({
  judgments: z
    .array(
      z.object({
        /** 可争议判断句（不是事实陈述） */
        text: z.string().min(4).max(160),
        /** 必须能在原文中定位的原话 */
        quote: z.string().min(2).max(300),
        answerId: z.string().min(1),
      }),
    )
    // 上限故意放宽（实测模型会超出），服务端不截断 —— 交给 merge 去重
    .max(40)
    .default([]),
})

const EXTRACT_SYSTEM = [
  '你是「两面」系统的 01 提取 Agent。输入是同一知乎问题下的一批回答（JSON）。', //
  '硬约束（违反任何一条即视为无效输出）：',
  '1. 只抽取「可争议的判断句」—— 表达立场/评价/预测的句子；事实陈述、纯叙事、纯数据一律不抽。',
  '2. 每条判断必须绑定至少一条回答原文里的原话引用（quote），原文里抽不出就丢弃该判断。',
  '3. quote 必须是 quote 所绑定那条回答正文的连续子串，禁止改写、缩写、翻译。',
  '4. 只使用输入里给出的 answerId，禁止编造。',
  '输出 JSON：{"judgments":[{"text":"判断句","quote":"原话","answerId":"回答id"}]}，不要输出任何其他文字。',
].join('\n')

function quoteLocatable(quote: string, content: string): boolean {
  const q = quote.trim()
  if (!q) return false
  if (content.includes(q)) return true
  // 宽松校验：允许模型截取时首尾略有出入，但主体必须能在原文找到
  const head = q.replace(/\s+/g, '').slice(0, 12)
  const body = content.replace(/\s+/g, '')
  return head.length >= 6 && body.includes(head)
}

/* ---------------------------- 02 归并 Agent ---------------------------- */

const MergeOut = z.object({
  judgments: z
    .array(
      z.object({
        /** 去重后的代表表述 */
        text: z.string().min(4).max(160),
        sourceQuotes: z.array(z.string().min(2).max(300)).max(4).default([]),
        /** 参与该议题的原回答 id */
        answerIds: z.array(z.string().min(1)).max(20).default([]),
      }),
    )
    // 上限放宽到 60（实测模型合并后仍可能超过 16）；服务端按契约裁到 15
    .max(60),
})

const MERGE_SYSTEM = [
  '你是「两面」系统的 02 归并 Agent。输入是一批已抽取的判断句（JSON，含来源回答 id）。',
  '硬约束：',
  '1. 语义聚类去重：同一议题的不同表述合并为一条，保留最具代表性、最中性的表述作为 text。',
  '2. 合并时保留全部来源：answerIds 必须是被合并判断的原 answerId，禁止编造；sourceQuotes 从被合并判断的 quote 里取。',
  '3. 不做立场判断、不改写含义、不丢弃少数派表述 —— 少数派恰恰是这个产品最要呈现的。',
  '4. 最终输出最多 15 条，按「议题重要性」从高到低排序。',
  '输出 JSON：{"judgments":[{"text":"代表表述","sourceQuotes":["原话"],"answerIds":["回答id"]}]}。',
].join('\n')

/* ---------------------------- 03 取向 Agent ---------------------------- */

const Placement = z.object({
  answerId: z.string().min(1),
  slot: SlotSchema,
  /** 归位理由必须绑定原话，无理由不采纳 */
  reason: z.string().min(4).max(240),
  /** 该答主支持其归位的原话 */
  quote: z.string().min(2).max(300),
})

const OrientOut = z.object({
  semanticAxis: z.object({
    left: z.string().min(1).max(40),
    right: z.string().min(1).max(40),
  }),
  placements: z.array(Placement).min(1).max(20),
})

const ORIENT_SYSTEM = [
  '你是「两面」系统的 03 取向 Agent。输入是一条判断 + 相关回答原文（JSON）。',
  '硬约束（违反任何一条即视为无效输出）：',
  '1. semanticAxis 的两端定义必须由这条判断的内容推导，禁止预设「正方/反方」「支持/反对」这类立场词。',
  '2. 每个归位必须给出 reason（绑定回答原文的理由）与 quote（原话），无理由不采纳。',
  '3. 允许归入中间档（slot 3），不强迫站边；确实无明确立场的回答直接不要归位。',
  '4. slot 1 = 左端，slot 5 = 右端（scaleDirection 固定 left_to_right，由系统写入，你不用输出）。',
  '5. slot 只表示这条判断内部的相对位置，不具备跨判断语义；不要对 slot 做任何跨判断比较或聚合。',
  '输出 JSON：{"semanticAxis":{"left":"…","right":"…"},"placements":[{"answerId":"…","slot":1,"reason":"…","quote":"…"}]}。',
].join('\n')

/* ------------------------------ Agent 实现 ------------------------------ */

interface LlmAgentsOptions {
  /** 单条回答喂给模型的正文上限（测试时可以调小省额度） */
  contentLimit?: number
}

export function createLlmAgents(opts: LlmAgentsOptions = {}): PipelineAgents {
  const contentLimit = opts.contentLimit ?? CONTENT_LIMIT

  async function callJson<T>(
    agent: 'extract' | 'merge' | 'orient',
    schema: z.ZodType<T>,
    system: string,
    userPayload: unknown,
    ctx: PipelineContext,
    stage: 'extract' | 'merge' | 'orient',
    /** 单次调用超时：merge 输入大、模型慢（实测 >60s），给更长预算 */
    timeoutMs = 90_000,
  ): Promise<T> {
    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: JSON.stringify(userPayload) },
    ]
    try {
      const res = await callAgent<T>(agent, {
        messages,
        jsonMode: true,
        temperature: 0.2, // 结构化抽取要稳定，温度压低
        timeoutMs,
        signal: ctx.signal,
        // 结构化输出校验：解析失败按「解析失败」重试（docs/03 §3.1）
        validate: (raw) => schema.parse(parseJsonLoose(raw)),
      })
      ctx.note(`llm.${agent}.ok`, {
        provider: res.provider,
        path: res.path,
        latencyMs: res.latencyMs,
        tokens: res.usage?.totalTokens ?? 0,
      })
      return res.content
    } catch (e) {
      const kind = e instanceof Error && 'kind' in e ? String((e as { kind: unknown }).kind) : 'unknown'
      ctx.note(`llm.${agent}.failed`, { kind })
      // parse（含 zod 校验失败）→ parse_error；其余 → llm_error（docs/03 §6.2）
      const mapped = kind === 'parse' ? 'parse_error' : 'llm_error'
      throw new PipelineError(
        `${agent} 调用失败（${kind}）: ${e instanceof Error ? e.message.slice(0, 160) : String(e).slice(0, 160)}`,
        mapped as 'parse_error' | 'llm_error',
        stage,
        true,
      )
    }
  }

  return {
    /* ---------------- 内容获取：3 Query 变体 + 去重合并 ---------------- */
    async fetchAnswers(qid, ctx) {
      if (!isLive()) {
        throw new PipelineError(
          'zhihu disabled (ZHIHU_LIVE=0)：真实内容获取被闸门挡住',
          'zhihu_error',
          'extract',
          false,
        )
      }

      // ① 定位题目标题（zhihu/title.ts）：titleHint → question_titles 永久缓存 → 失败。
      //    2026-09-12 产品决策：产品输入只有「问题文字」，qid 不做任何反查 ——
      //    解析是纯本地查表，零网络。zhihu_search 永远不参与标题推断。
      const title = resolveQuestionTitle(qid, ctx.titleHint)
      if (!title) {
        // 无 hint 且缓存未命中：绝不假造，failed(zhihu_error, retryable)
        throw new PipelineError(
          '题目标题缺失（无 titleHint 且缓存未命中）',
          'zhihu_error',
          'extract',
          true,
        )
      }
      // hint 也进缓存：下次同题的懒生成不用再带 hint
      if (ctx.titleHint?.trim()) rememberHint(qid, ctx.titleHint)

      const question = title
      const variants = buildVariants(question)
      if (variants.length === 0) variants.push(qid)

      // ② 变体搜索 + 按 answerId 去重
      const items = await searchDedup(variants, ctx)
      const candidates = items
        .map(toRawAnswer)
        .filter((a): a is RawAnswer => a !== null)

      // ③ 回答 URL 强校验（契约 ENDPOINTS.analysis 注释，防「答非所问快照」的最后闸门）。
      //    2026-09-12 team-lead 二次拍板：保持最严、一个字节都不松，「混入题保留」
      //    的松化方案已否决 —— 混入的相关题回答正是「答非所问快照」的原材料：
      //    D1 实测截断 qid 搜出别的题、照样产出结构合法的快照（按日缓存活一整天），
      //    这道闸门就是那次事故的墓碑。sampleCount 因此变小是诚实的代价。
      //    只保留属于目标问题（Url 含 /question/<qid>/）的回答；一条都没有 → failed。
      const answers = candidates.filter((a) => questionIdFromUrl(a.url) === qid)
      const foreign = candidates.length - answers.length
      if (foreign > 0) {
        ctx.note('fetchAnswers.foreignDropped', { foreign, kept: answers.length })
        log.warn('llm.fetchAnswers.foreignDropped', { qid, foreign, kept: answers.length })
      }

      ctx.report({ stage: 'extract', stageRatio: 0, sampleCount: answers.length })
      log.info('llm.fetchAnswers', { qid, title: 'found', answers: answers.length, foreignDropped: foreign })

      if (answers.length === 0) {
        throw new PipelineError(
          '回答均不属于目标问题（URL 强校验不通过）',
          'zhihu_error',
          'extract',
          true,
        )
      }
      return { question, answers }
    },

    /* ---------------- 01 提取：一批 3–5 条回答 ---------------- */
    async extract(batch, ctx) {
      const payload = batch.map((a) => ({
        answerId: a.answerId,
        content: truncate(a.content, contentLimit),
        authorName: a.authorName,
        authority: a.authority,
        voteUp: a.voteUp,
      }))
      const out = await callJson('extract', ExtractOut, EXTRACT_SYSTEM, payload, ctx, 'extract')
      const byId = new Map(batch.map((a) => [a.answerId, a]))

      let dropped = 0
      const kept = (out.judgments ?? []).filter((j) => {
        const a = byId.get(j.answerId)
        // 只认输入里的 answerId + 原话必须可定位（§4.2 硬约束 ②③）
        if (!a || !quoteLocatable(j.quote, a.content)) {
          dropped++
          return false
        }
        return true
      })
      if (dropped > 0) ctx.note('extract.dropped', { dropped, kept: kept.length })
      return kept
    },

    /* ---------------- 02 归并：单路串行 ---------------- */
    async merge(items, ctx) {
      const payload = items.map((it, i) => ({
        id: `x${i + 1}`,
        text: it.text,
        quote: it.quote,
        answerId: it.answerId,
      }))
      const out = await callJson('merge', MergeOut, MERGE_SYSTEM, payload, ctx, 'merge', 120_000)

      const known = new Set(items.map((i) => i.answerId))
      const out2: MergedJudgment[] = (out.judgments ?? [])
        .map((j, i) => {
          // answerIds 只认输入里出现过的 id，防编造；全被滤掉时退化为空（orient 阶段仍可定位）
          const ids = [...new Set((j.answerIds ?? []).filter((id) => known.has(id)))]
          return {
            id: `j${i + 1}`,
            text: j.text,
            sourceQuotes: j.sourceQuotes ?? [],
            answerIds: ids,
          }
        })
        // 契约建议 10–15 条：超出时按模型给出的顺序保留前 15（保持模型自己的重要性排序）
        .slice(0, 15)
      // 服务端定 id：模型只负责内容，id 由我们保证唯一与稳定
      return out2
    },

    /* ---------------- 03 取向：每判断一路 ---------------- */
    async orient(judgment, answers, ctx) {
      const byId = new Map(answers.map((a) => [a.answerId, a]))
      const related = judgment.answerIds
        .map((id) => byId.get(id))
        .filter((a): a is RawAnswer => !!a)
      // answerIds 缺失时（merge 未回传）退化为全池按投票取头部，保证取向阶段仍有原文可依
      const pool =
        related.length > 0
          ? related
          : [...answers].sort((a, b) => b.voteUp - a.voteUp).slice(0, 6)

      const payload = {
        judgment: judgment.text,
        answers: pool.map((a) => ({
          answerId: a.answerId,
          content: truncate(a.content, contentLimit),
          authorName: a.authorName,
          authority: a.authority,
          voteUp: a.voteUp,
        })),
      }
      const out = await callJson('orient', OrientOut, ORIENT_SYSTEM, payload, ctx, 'orient')

      // 归位 → AuthorRef（带 slot）；无理由/无原话不采纳（§4.2 硬约束 ②）
      type Placed = { ref: import('@two-sides/contract').AuthorRef; slot: Slot }
      const placed = new Map<string, Placed>() // key: answerId

      for (const p of out.placements) {
        const a = byId.get(p.answerId)
        if (!a) continue
        const reason = p.reason.trim()
        const quote = p.quote.trim()
        if (!reason || !quote) continue
        // 原话必须可定位；定位失败则退化为用回答正文开头当引用（仍可回溯到原文）
        const finalQuote = quoteLocatable(quote, a.content) ? quote : truncate(a.content, 120)
        placed.set(p.answerId, {
          slot: p.slot,
          ref: {
            name: a.authorName,
            badge: a.authorBadge,
            authority: a.authority,
            quote: finalQuote,
            url: a.url,
            reason,
            voteUp: a.voteUp,
          },
        })
      }

      // 同一答主在同一判断只计 1 次（§5.2 规则 1）：按名字去重，保留票数最高的一条
      const byAuthor = new Map<string, Placed>()
      for (const entry of placed.values()) {
        const prev = byAuthor.get(entry.ref.name)
        if (!prev || entry.ref.voteUp > prev.ref.voteUp) byAuthor.set(entry.ref.name, entry)
      }

      const buckets = new Map<Slot, import('@two-sides/contract').AuthorRef[]>()
      for (const entry of byAuthor.values()) {
        const arr = buckets.get(entry.slot) ?? []
        arr.push(entry.ref)
        buckets.set(entry.slot, arr)
      }

      const distribution = [...buckets.entries()]
        .filter(([, authors]) => authors.length > 0) // 空档不出现（规则 4）
        .sort((a, b) => a[0] - b[0])
        .map(([slot, authors]) => ({ slot, authors }))

      const participantCount = distribution.reduce((n, b) => n + b.authors.length, 0)
      if (participantCount === 0) return null // 该判断整体缺席（partial 语义由 pipeline 记 note）

      const slotCounts = [0, 0, 0, 0, 0]
      const authorityDistribution = [0, 0, 0, 0, 0]
      for (const b of distribution) {
        slotCounts[b.slot - 1] = b.authors.length
        for (const a of b.authors) {
          if (a.authority >= 3) authorityDistribution[b.slot - 1]! += 1
        }
      }

      const oriented: OrientedJudgment = {
        id: judgment.id,
        text: judgment.text,
        participantCount,
        divergence: divergenceFromCounts(slotCounts),
        commentChallengeCount: undefined, // D1：评论层待真实 payload 确认后接入
        orientStatus: 'done',
        semanticAxis: { left: out.semanticAxis.left, right: out.semanticAxis.right },
        scaleDirection: 'left_to_right',
        distribution,
        authorityDistribution,
        relatedAnswerIds: [...placed.keys()],
      }
      // 规则 7：participantCount === 1 时熵恒为 0
      if (participantCount === 1) oriented.divergence = 'low'
      return oriented
    },

    /* ---------------- 04 综述：题级一次，zhida 优先 ---------------- */
    async summarize(answers, ctx): Promise<SummarizeResult> {
      const top = [...answers].sort((a, b) => b.voteUp - a.voteUp).slice(0, 8)
      const prompt = [
        '以下是一个知乎问题下的部分回答摘录。请写一段 80–160 字的中立综述：',
        '概括这个话题上人们的主要分歧点在哪里，两侧各自的理由是什么。',
        '硬约束：不评判对错、不站队、不使用「正确/错误」这类结论性措辞，只描述分歧结构。',
        '直接输出综述正文，不要任何前缀或解释。',
        '',
        ...top.map((a) => `【${a.authorName}】${truncate(a.content, 300)}`),
      ].join('\n')

      // 直答优先：额度 100/日是最紧资源，任何失败都要可观测
      try {
        const r = await zhidaChat([{ role: 'user', content: prompt }], { signal: ctx.signal })
        ctx.note('summary.zhida.ok', { model: r.model, tokens: r.usage?.totalTokens ?? 0 })
        return { summary: truncate(r.content, SUMMARY_MAX_LEN), source: 'zhida' }
      } catch (e) {
        const isQuota = e instanceof ZhidaError && e.kind === 'quota'
        zhidaCounters.degraded++
        log.warn('summary.zhida.degraded', {
          qid: ctx.qid,
          kind: e instanceof ZhidaError ? e.kind : 'unknown',
          isQuota,
          degradedTotal: zhidaCounters.degraded,
        })
        ctx.note('summary.zhida.degraded', { kind: e instanceof ZhidaError ? e.kind : 'unknown' })
      }

      // 降级外部 LLM（providers.yaml 的 summaryFallback）
      const r2 = await callAgent('summaryFallback', {
        messages: [
          {
            role: 'system',
            content:
              '你是「两面」系统的综述 Agent。只描述分歧结构，不评判对错、不站队，输出 80–160 字正文，不要任何前缀。',
          },
          { role: 'user', content: prompt },
        ],
        temperature: 0.5,
        signal: ctx.signal,
      })
      ctx.note('summary.fallback.ok', { tokens: r2.usage?.totalTokens ?? 0 })
      return { summary: truncate(r2.content, SUMMARY_MAX_LEN), source: 'fallback' }
    },
  }
}

/** 观测计数导出（pipeline:test 打印用） */
export { zhihuCounters, zhidaCounters, llmCounters }
