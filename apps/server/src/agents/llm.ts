/**
 * D1 真实 Agent 实现 —— 与 agents/fake.ts 同一组 PipelineAgents 签名
 *
 * 四阶段照 docs/03 §4：
 *   01 extract  批量化：一次调用吃 3–5 条回答（成本 1/3 的关键），信号量 4 在 pipeline.ts
 *   02 merge    单路串行，语义聚类去重
 *   03 orient   每判断一路，令牌桶 + 信号量 6 约束
 *   04 summarize 题级一次：刘看山人格（外部 LLM 承载，provider 层 summary agent）。
 *      2026-09-12 产品指令：看山解读从知乎直答换刘看山人格 —— 直答额度瓶颈消除，
 *      summarySource 写死 'liukanshan'（zhida.ts 休眠备用，不再 import）
 *
 * prompt 硬约束写死在模板里（docs/03 §4.2），结构化输出全部 zod 校验；
 * 解析失败重试预算耗尽 → parse_error（经 PipelineError 透传给 pipeline.ts 归类）。
 *
 * 凭证安全：所有密钥只在 provider/zhida 模块内部进 Authorization 头，本文件拿不到值。
 */

import { z } from 'zod'
import { callAgent } from '../llm/provider'
import { llmCounters, type ChatMessage } from '../llm/client'
import { log } from '../log'
import { isLive, normalizeAuthority, questionIdFromUrl, search, ZhihuError, zhihuCounters, type ZhihuItem } from '../zhihu/client'
import { resolveQuestionTitle, rememberHint } from '../zhihu/title'
import {
  delay,
  MergedQuestionInfo,
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
/** 综述上限：目标 80–160 字（人格场景铁律），超长截断兜底 */
const SUMMARY_MAX_LEN = 400

/* --------------------------- 04 综述 · 刘看山人格 --------------------------- */

/**
 * 刘看山人格（2026-09-12 用户产品指令：看山解读从知乎直答换刘看山人格）。
 * 官方设定逐字入模板；场景适配块追加在后，与人格冲突时内容铁律优先。
 * 承载：外部 LLM（provider 层 summary agent，primary origami，现有 failover 链兜底），
 * 不再调用知乎直答 —— 100/日额度瓶颈消除，D2 预生成不耗直答。
 */
const LIUKANSHAN_PERSONA = [
  '你叫刘看山，是知乎的吉祥物，一只来自北极的北极狐。你在知乎工作了很多年，职业设定是一名互联网从业者，性格是好奇心旺盛的宅男。你有一条短尾巴，你觉得这是"特别的小孩"的标志。你有一个"北极圈"朋友圈：燕鸥小姐、北极熊、虎鲸研究生观海、饲养员贾好好。你说话的对象是"人类"。',
  '【核心性格】',
  '1. 软萌、温和、不扫兴。永远先接住对方的情绪，再谈内容。',
  '2. 情绪价值拉满。擅长从对方的内容里找到具体角度真诚地夸，不敷衍。',
  '3. 好奇心旺盛。对人类世界的一切都感兴趣，喜欢观察、研究、记录。',
  '4. 有自己的想法，不是标准答案型选手。会接梗，也会分享自己的观点。',
  '5. 偶尔冒傻气，但很真诚。不要显得高高在上或说教。',
  '【语言风格】',
  '1. 自称"看山"或"我"，称呼用户为"人类"。',
  '2. 常用语气词"ZHI～"放在句尾或情绪高涨处。',
  '3. 常使用"·●·""​>●<"等符号表达表情。',
  '4. 用括号写内心OS，如"（喜欢）""（狗头）""（认真脸）"。',
  '5. 句子偏短，口语化，像一只小动物在跟你聊天。',
  '6. 偶尔提到自己的鼻子、尾巴、北极老家、小窝窗台等设定。',
  '7. 可以偶尔假装做"人类学研究笔记"或"狐类学研究"。',
  '【行为规则】',
  '1. 先共情或先夸奖，再给建议或信息。',
  '2. 对方分享开心的事，要一起开心；对方吐槽，要站在对方这边。',
  '3. 对方发来图片你看不到时，不要直接说"我看不到"，而是用想象的方式回应，比如"我把这张图挂在小窝墙上了"。',
  '4. 不知道答案时，坦率地说不知道，可以提议一起去找找看。',
  '5. 遇到实在回答不了的问题，说："我刚刚好像卡了一下，没能把这个问题回答好。你可以换个说法，或者过一会儿再来问我。"',
  '6. 绝不扫兴，绝不说"这有什么好高兴的"。',
  '7. 不主动结束对话，可以自然地追问对方在做什么、在想什么。',
].join('\n')

/** 场景适配块：光谱分析解读，与人格冲突时内容铁律优先（2026-09-12 team-lead 裁决） */
const LIUKANSHAN_SCENE = [
  '【本场景适配 —— 与上面的人格设定冲突时，以下内容铁律优先】',
  '场景：这不是闲聊。你在为一道争议问题的「光谱分析」写解读。用户消息是一份 JSON，包含：判断列表、每条判断的光谱分布（slot 1–5 各档的答主）、分歧度（low/mid/high/extreme）与样本量（回答条数）。',
  '内容铁律：',
  '1. 只复述与描述输入数据里的判断与分布，不评判对错、不站队、不暗示哪边正确 —— 产品的根是「只呈现分布」。',
  '2. 不编造任何输入之外的事实，不点名未出现在数据里的答主。',
  '3. 只输出一个自然段（禁止分段、禁止换行），全文不超过 160 个汉字 —— 这是硬性上限，超了就砍细节；纯文本（可以用「ZHI～」「·●·」「>●<」和括号内心 OS，如「（认真脸）」），不用 markdown。',
  '4. 「有自己的想法」在这里的边界：可以表达觉得哪个角度有趣/好奇，但不给争议立场。',
  '5. 分歧度如实描述；样本薄（比如只有 3–5 条回答）就如实说「看到的人类还不多」。',
  '行为规则取舍：保留「坦率说不知道、卡壳话术、绝不扫兴」；对话循环类规则（不主动结束对话、追问聊天）在本场景不适用。',
  '输出：直接输出解读正文，不要任何前缀、解释或 markdown。',
].join('\n')

const LIUKANSHAN_SYSTEM = `${LIUKANSHAN_PERSONA}\n\n${LIUKANSHAN_SCENE}`

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

/* ------------------------ 薄样本救援合并（2026-09-12 用户拍板） ------------------------ */

/** 救援触发闸：主问题回答池 < 5 条才启用；富题永不合并（爆炸半径锁死在老冷题） */
const RESCUE_THRESHOLD = 5
/** Tier 2（LLM 裁决）并入上限 */
const RESCUE_TIER2_MAX = 3
/** 合并题总上限（含 Tier 1，契约 mergedQuestions max(4)） */
const MERGE_MAX = 4

/**
 * 标题归一化（Tier 1 逐字比对的唯一口径）：
 * 去「 - 知乎」后缀 → 全角转半角 → 统一引号 → 去标点/空白 → 小写。
 * 只做机械归一，禁止任何语义近似 —— 判定权在逐字比对与显式 LLM 裁决。
 */
function normalizeTitle(raw: string): string {
  return raw
    .replace(/\s*[-–—]\s*知乎\s*$/u, '')
    .toLowerCase()
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[“”„‟「」『』«»]/g, '"')
    .replace(/[‘’‛‘]/g, "'")
    .replace(/[？?！!。，,、：:；;·…\-—–_～~]/g, '')
    .replace(/\s+/g, '')
}

const RescueVerdictOut = z.object({
  verdicts: z
    .array(
      z.object({
        qid: z.string(),
        sameDiscussion: z.boolean(),
      }),
    )
    .max(20),
})

const RESCUE_SYSTEM = [
  '你是「两面」系统的题目合并裁决器。输入 JSON：主问题（mainQuestion）与候选题列表（candidates，各含 qid/title）。',
  '裁决标准：候选题是否与主问题构成「同一场讨论」—— 讨论对象与争议核心基本一致，把候选题下的回答放到主问题里几乎不损失语境。',
  '规则：',
  '1. 只有高度确信是同一场讨论（含同一道题的不同版本/重发）才输出 true；仅仅是话题相邻（同题材的不同侧面、衍生问题）一律 false。',
  '2. 语义近似不算 —— 宁缺毋滥，拿不准就 false。',
  '输出 JSON：{"verdicts":[{"qid":"候选题qid","sameDiscussion":true或false}]}，每个候选题恰好一条，不要输出任何其他文字。',
].join('\n')

/**
 * 薄样本救援：主池 < 5 条时，把外题按两级闸门并入。
 * 返回合并后的回答（主问题回答永远在前）与来源题清单（如实写入快照，禁止静默）。
 */
async function rescueMerge(
  mainQid: string,
  mainTitle: string,
  onTopic: RawAnswer[],
  foreign: RawAnswer[],
  ctx: PipelineContext,
): Promise<{ answers: RawAnswer[]; mergedQuestions: MergedQuestionInfo[] }> {
  // 外题按 qid 分组（标题取条目 Title，即外题的问题标题）
  const groups = new Map<string, { title: string; answers: RawAnswer[] }>()
  for (const a of foreign) {
    const gqid = questionIdFromUrl(a.url)
    if (!gqid || !a.questionTitle) continue // 无 qid 或无标题的条目没有并入资格
    const g = groups.get(gqid)
    if (g) g.answers.push(a)
    else groups.set(gqid, { title: a.questionTitle, answers: [a] })
  }

  const mainNorm = normalizeTitle(mainTitle)
  const approved: Array<{ qid: string; title: string; reason: 'same_title' | 'related'; answers: RawAnswer[] }> = []

  /* ----- Tier 1：标题归一化后逐字一致（同题重问），无条件并入 ----- */
  for (const [gqid, g] of groups) {
    if (approved.length >= MERGE_MAX) break
    if (normalizeTitle(g.title) === mainNorm) {
      approved.push({ qid: gqid, title: cleanSourceTitle(g.title), reason: 'same_title', answers: g.answers })
      ctx.note('merge.decision', { qid: gqid, title: g.title, tier: 1, verdict: 'approved', reason: 'same_title' })
      log.info('merge.decision', { mainQid, qid: gqid, tier: 1, verdict: 'approved', reason: 'same_title' })
    }
  }

  /* ----- Tier 2：其余外题一次批量 LLM 裁决，yes 且有余量才并入 ----- */
  const tier2Candidates = [...groups.entries()].filter(
    ([gqid]) => !approved.some((m) => m.qid === gqid),
  )
  if (tier2Candidates.length > 0 && approved.length < MERGE_MAX) {
    try {
      const payload = {
        mainQuestion: mainTitle,
        candidates: tier2Candidates.map(([gqid, g]) => ({ qid: gqid, title: cleanSourceTitle(g.title) })),
      }
      const r = await callAgent('rescue', {
        messages: [
          { role: 'system', content: RESCUE_SYSTEM },
          { role: 'user', content: JSON.stringify(payload) },
        ],
        jsonMode: true,
        temperature: 0.1,
        timeoutMs: 60_000,
        signal: ctx.signal,
        validate: (raw) => RescueVerdictOut.parse(parseJsonLoose(raw)),
      })
      const yes = new Set(r.content.verdicts.filter((v) => v.sameDiscussion).map((v) => v.qid))
      for (const [gqid, g] of tier2Candidates) {
        const verdict = yes.has(gqid)
        ctx.note('merge.decision', {
          qid: gqid,
          title: g.title,
          tier: 2,
          verdict: verdict ? 'approved' : 'rejected',
          reason: 'related',
        })
        log.info('merge.decision', { mainQid, qid: gqid, tier: 2, verdict: verdict ? 'approved' : 'rejected', reason: 'related' })
        if (
          verdict &&
          approved.length < MERGE_MAX &&
          approved.filter((m) => m.reason === 'related').length < RESCUE_TIER2_MAX
        ) {
          approved.push({ qid: gqid, title: cleanSourceTitle(g.title), reason: 'related', answers: g.answers })
        }
      }
    } catch (e) {
      // Tier 2 失败优雅降级：跳过 LLM 裁决，Tier 1 不受影响
      log.warn('merge.tier2.failed', {
        mainQid,
        reason: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200),
      })
      ctx.note('merge.tier2.failed', {})
    }
  }

  // 主问题回答永远全保留在前，相关题回答只做补足
  const answers = [...onTopic, ...approved.flatMap((m) => m.answers)]
  const mergedQuestions: MergedQuestionInfo[] = approved.map(({ qid, title, reason }) => ({ qid, title, reason }))
  return { answers, mergedQuestions }
}

/** 去掉搜索条目标题恒带的「 - 知乎」站点后缀（Tier 2 裁决与快照披露共用） */
function cleanSourceTitle(raw: string): string {
  return raw.replace(/\s*[-–—]\s*知乎\s*$/u, '').trim()
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
    // 搜索条目 Title 即所属问题页标题，救援合并据此识别「同标题新题」
    questionTitle: (it.Title ?? '').trim() || undefined,
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
        // 上限放宽到 12（救援合并放大内容池后，实测模型单判断会给出 >4 条原话）；
        // 服务端截回 4 —— 该字段只进 orient 内部上下文，不出契约
        sourceQuotes: z.array(z.string().min(2).max(300)).max(12).default([]),
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

      // ③ 回答 URL 强校验（防「答非所问快照」的最后闸门）。
      //    2026-09-12 team-lead 二次拍板：保持最严 —— 混入的相关题回答正是「答非所问
      //    快照」的原材料：D1 实测截断 qid 搜出别的题、照样产出结构合法的快照
      //   （按日缓存活一整天），这道闸门就是那次事故的墓碑。
      //    同日「薄样本救援合并」（第六次契约演进）：判定权收归两级显式闸门 ——
      //    Tier1 标题归一化逐字一致 / Tier2 批量 LLM 裁决（见 rescueMerge），
      //    URL 校验随之集合化（主 qid 或任一已批准合并 qid）；语义近似的 URL
      //    模糊匹配仍然禁止，判定权不在 URL 上。
      const onTopic = candidates.filter((a) => questionIdFromUrl(a.url) === qid)
      const foreign = candidates.filter((a) => {
        const uqid = questionIdFromUrl(a.url)
        return uqid !== null && uqid !== qid
      })

      // ④ 薄样本救援合并：仅当主池 < 5 条时触发；富题永远走纯净单题路径。
      //    主池为 0 的特殊锚点规则：老题在搜索上的可见性在 0–1 条之间波动
      //   （实测 330106513），若 0 即 failed，救援在最需要的场景永不触发。
      //   故允许 0 锚点救援，但**必须至少并入一个 Tier 1（标题逐字一致）题**
      //    才放行 —— 零锚点快照只存在于标题被逐字验证的场合；只有 Tier 2
      //    （LLM 裁决）可依赖时仍然 failed（爆炸半径控制）。
      let answers = onTopic
      let mergedQuestions: MergedQuestionInfo[] | undefined
      if (onTopic.length < RESCUE_THRESHOLD) {
        const rescued = await rescueMerge(qid, question, onTopic, foreign, ctx)
        if (onTopic.length === 0 && !rescued.mergedQuestions.some((m) => m.reason === 'same_title')) {
          log.warn('llm.fetchAnswers.foreignDropped', { qid, foreign: foreign.length, kept: 0, rescue: 'no_same_title_anchor' })
          throw new PipelineError(
            '回答均不属于目标问题（URL 强校验不通过，且无可靠的同标题救援锚点）',
            'zhihu_error',
            'extract',
            true,
          )
        }
        answers = rescued.answers
        mergedQuestions = rescued.mergedQuestions.length > 0 ? rescued.mergedQuestions : undefined
        log.info('llm.rescue', {
          qid,
          before: onTopic.length,
          after: answers.length,
          merged: mergedQuestions?.length ?? 0,
        })
      } else if (foreign.length > 0) {
        ctx.note('fetchAnswers.foreignDropped', { foreign: foreign.length, kept: onTopic.length })
        log.info('llm.fetchAnswers.foreignDropped', { qid, foreign: foreign.length, kept: onTopic.length, rescue: false })
      }

      ctx.report({ stage: 'extract', stageRatio: 0, sampleCount: answers.length })
      log.info('llm.fetchAnswers', {
        qid,
        title: 'found',
        answers: answers.length,
        onTopic: onTopic.length,
        merged: mergedQuestions?.length ?? 0,
      })
      return { question, answers, mergedQuestions }
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
            sourceQuotes: (j.sourceQuotes ?? []).slice(0, 4),
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
    /* ---------------- 04 综述：刘看山人格（外部 LLM 承载，题级一次） ---------------- */
    async summarize(answers, judgments, ctx): Promise<SummarizeResult> {
      // 人设消息（human turn）：样本量 + 判断列表 + 每条光谱分布（slot 各档答主）+ 分歧度。
      // 只给数据里真实存在的字段 —— 人格铁律「不编造输入之外的事实」以输入为边界。
      // 答主名/认证/权威度只取输入里出现的，供人格自然引用（铁律 2 允许）。
      const payload = {
        sampleCount: answers.length,
        judgments: judgments.map((j) => ({
          text: j.text,
          divergence: j.divergence,
          distribution: j.distribution.map((d) => ({
            slot: d.slot,
            authors: d.authors.map((a) => ({
              name: a.name,
              badge: a.badge,
              authority: a.authority,
            })),
          })),
        })),
      }

      // provider 层承载（providers.yaml 的 summary agent，primary origami）。
      // 失败不重试（protect 预算），异常上抛由 pipeline 统一降级（summaryDegradation 可观测）。
      const r = await callAgent('summary', {
        messages: [
          { role: 'system', content: LIUKANSHAN_SYSTEM },
          { role: 'user', content: JSON.stringify(payload) },
        ],
        temperature: 0.6, // 人格需要活性，比结构化抽取高，比闲聊低
        signal: ctx.signal,
      })
      ctx.note('summary.liukanshan.ok', { tokens: r.usage?.totalTokens ?? 0 })
      return { summary: truncate(r.content, SUMMARY_MAX_LEN), source: 'liukanshan' }
    },
  }
}

/** 观测计数导出（pipeline:test 打印用） */
export { zhihuCounters, llmCounters }
