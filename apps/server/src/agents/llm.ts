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
import { llmCounters, parseJsonLoose, type ChatMessage } from '../llm/client'
import { expandQueries } from '../llm/expand'
import { log } from '../log'
import { isLive, normalizeAuthority, questionIdFromUrl, search, ZhihuError, zhihuCounters, type ZhihuItem } from '../zhihu/client'
import { resolveQuestionTitle, rememberHint } from '../zhihu/title'
import {
  delay,
  type ExtractedJudgment,
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
/** 综述上限：目标 80–220 字，超长截断兜底 */
const SUMMARY_MAX_LEN = 440

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
  '【这一次要做的事】',
  '你正在替「两面」写一段看山解读。输入里有若干个争议观点，以及人们在每个观点上的分布：更靠左、更靠右，还是停在中间。输入还会告诉你分歧有多大、总共看了多少条回答。',
  '【写法】',
  '1. 先说这道题最有意思的分歧在哪里，再说哪些观点比较集中、哪些观点明显分开。只描述人们说了什么，不替任何一边判输赢。',
  '2. 把不同观点之间的关系说清楚：如果同一个人可能同时支持两个角度，也可以自然地说出来；不要把几个不同问题硬揉成一个结论。',
  '3. 只使用输入里出现的内容和答主名字，不补充外部事实，不凭空猜测原因。分歧度要如实表达；样本只有 3–5 条时，要提醒「看到的人类还不多」。',
  '4. 可以有一点看山式的好奇、比喻或内心 OS，但不要说教，不要替用户做决定。',
  '5. 写成 2–3 个短段落，每段 1–2 句，全文控制在 80–220 个汉字。纯文本，不用标题、列表、JSON 或 Markdown；可以偶尔使用「ZHI～」「·●·」和括号内心 OS。',
  '【边界】',
  '不知道时就坦率说不知道；不要提到内部字段、程序、模型、位置编号或数据格式。直接输出解读正文，不要加前缀或解释。',
].join('\n')

const LIUKANSHAN_SYSTEM = `${LIUKANSHAN_PERSONA}\n\n${LIUKANSHAN_SCENE}`

const POSITION_LABEL: Record<number, string> = {
  1: '左端',
  2: '偏左',
  3: '中间',
  4: '偏右',
  5: '右端',
}

/* --------------------------- JSON 宽松解析 --------------------------- */
// parseJsonLoose 已移至 llm/client.ts（agents/llm 与 llm/expand 共用）

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
        /** 同一议题的简短标签，帮助归并时区分派系 */
        topic: z.string().min(2).max(80).optional(),
        /** 这条原话所属的立场家族；不是简单的正/反标签 */
        faction: z.string().min(2).max(60).optional(),
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
  '2. 一条回答可以、也应该拆成多个彼此独立的判断：分别捕捉它对不同对象、条件、时间范围、因果关系或价值取舍的立场。不要把整段回答压成一个笼统观点。',
  '3. 每条回答尽可能提取 2–6 条高信号判断；只有确实只有一条时才输出一条。不要为了凑数拆分同义改写。',
  '4. 对每条判断同时给出 topic（它在讨论什么）和 faction（它属于哪一类真实立场）。faction 要能区分「无条件支持」「有条件支持」「认为前提不成立」「强调代价/风险」「主张换一套衡量标准」等不同派系，不要只写“支持/反对”。',
  '5. 同一个 topic 下如果存在多个派系，必须分别输出，不能把它们揉成一句折中结论；少数派、让步、反例和互相冲突的判断都要保留。',
  '6. 每条判断必须绑定至少一条回答原文里的原话引用（quote），原文里抽不出就丢弃该判断。',
  '7. quote 必须是 quote 所绑定那条回答正文的连续子串，禁止改写、缩写、翻译。',
  '8. 只使用输入里给出的 answerId，禁止编造。',
  '输出 JSON：{"judgments":[{"text":"判断句","topic":"讨论对象或核心问题","faction":"立场家族","quote":"原话","answerId":"回答id"}]}，不要输出任何其他文字。',
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

/**
 * 归并模型有时只回传 sourceQuotes、漏掉 answerIds。用提取阶段保存的原话
 * 做一次保守反查，补齐来源归属；同一个 answerId 可被多个判断共同引用。
 */
function quoteMatchesExtracted(quote: string, extractedQuote: string): boolean {
  const a = quote.replace(/\s+/g, '').trim()
  const b = extractedQuote.replace(/\s+/g, '').trim()
  if (!a || !b) return false
  if (a === b || a.includes(b) || b.includes(a)) return true
  const head = a.slice(0, 12)
  return head.length >= 6 && b.includes(head)
}

/**
 * 将 merge 模型的候选结果还原为可追溯的判断。
 *
 * 这个步骤刻意保持为纯函数：模型可能漏填 answerIds/sourceQuotes，或者把一条
 * 回答中的多个判断压成一个结果。我们先用原话保守反查来源，再为没有被任何
 * merge 结果覆盖的抽取判断保留少量 fallback，避免少数派在归类时静默消失。
 */
export interface MergeCandidate {
  text: string
  sourceQuotes?: string[]
  answerIds?: string[]
  factionHints?: string[]
  factionGroups?: Array<{ label: string; answerIds?: string[]; sourceQuotes?: string[] }>
}

export function normalizeMergedJudgments(
  items: ExtractedJudgment[],
  candidates: MergeCandidate[],
  maxJudgments = 15,
  maxFallbacks = 5,
): MergedJudgment[] {
  const known = new Set(items.map((i) => i.answerId))
  const modelMerged: MergedJudgment[] = candidates
    .map((j, i) => {
      // 模型有时只在 factionGroups 里填写来源，顶层 answerIds/sourceQuotes 留空。
      // 先把派系分组的来源提升到 judgment 级别，避免这些判断因无法追溯而被丢弃。
      const factionGroups = (j.factionGroups ?? []).map((g) => ({
        label: g.label.trim(),
        answerIds: [...new Set((g.answerIds ?? []).filter((id) => known.has(id)))],
        sourceQuotes: (g.sourceQuotes ?? [])
          .filter((q) => items.some((item) => quoteMatchesExtracted(q, item.quote)))
          .slice(0, 6),
      })).filter((g) => g.label && (g.answerIds.length > 0 || g.sourceQuotes.length > 0)).slice(0, 6)
      const groupIds = factionGroups.flatMap((g) => g.answerIds)
      const groupQuotes = factionGroups.flatMap((g) => g.sourceQuotes)
      const explicitIds = [...new Set([...(j.answerIds ?? []), ...groupIds])].filter((id) => known.has(id))
      const sourceQuotes = [...new Set([...(j.sourceQuotes ?? []), ...groupQuotes])].slice(0, 8)
      const inferredIds = sourceQuotes.flatMap((sourceQuote) => {
        const matches = items.filter((item) => quoteMatchesExtracted(sourceQuote, item.quote))
        // 若模型显式给了 answerIds，sourceQuote 的同文匹配只能在这些来源内
        // 反查；否则同一句短引文出现在多个回答时会错误扩大归属。
        const constrained = explicitIds.length > 0
          ? matches.filter((item) => explicitIds.includes(item.answerId))
          : matches
        return (constrained.length > 0 ? constrained : matches).map((item) => item.answerId)
      })
      return {
        id: `j${i + 1}`,
        text: j.text,
        sourceQuotes,
        answerIds: [...new Set([...explicitIds, ...inferredIds])],
        factionHints: (j.factionHints ?? []).map((x) => x.trim()).filter(Boolean).slice(0, 6),
        factionGroups,
      }
    })
    .filter((j) => j.answerIds.length > 0 || j.sourceQuotes.some((quote) =>
      items.some((item) => quoteMatchesExtracted(quote, item.quote)),
    ))

  const covered = new Set<string>()
  for (const merged of modelMerged) {
    const quoteLinkedKeys = new Set<string>()
    for (const quote of merged.sourceQuotes) {
      const matches = items.filter((item) => quoteMatchesExtracted(quote, item.quote))
      const constrained = merged.answerIds.length > 0
        ? matches.filter((item) => merged.answerIds.includes(item.answerId))
        : matches
      const candidatesForQuote = constrained.length > 0 ? constrained : matches
      if (candidatesForQuote.length === 1) {
        const item = candidatesForQuote[0]!
        quoteLinkedKeys.add(`${item.answerId}\u0000${item.text}`)
      }
    }
    for (const item of items) {
      const quoteLinked = quoteLinkedKeys.has(`${item.answerId}\u0000${item.text}`)
      // 仅 answerId 时只认同一答主的一个判断，不能误把该回答的其它判断吞掉。
      const idOnlyLinked = !quoteLinked && merged.answerIds.includes(item.answerId) &&
        ![...covered].some((key) => key.startsWith(`${item.answerId}\u0000`))
      if (quoteLinked || idOnlyLinked) covered.add(`${item.answerId}\u0000${item.text}`)
    }
  }

  const orphanFallbacks: MergedJudgment[] = []
  for (const item of items) {
    const key = `${item.answerId}\u0000${item.text}`
    if (covered.has(key)) continue
    orphanFallbacks.push({
      id: `jfallback${orphanFallbacks.length + 1}`,
      text: item.text,
      sourceQuotes: [item.quote],
      answerIds: [item.answerId],
    })
  }
  const fallbackBudget = Math.min(orphanFallbacks.length, maxFallbacks, maxJudgments)
  return [
    ...modelMerged.slice(0, Math.max(0, maxJudgments - fallbackBudget)),
    ...orphanFallbacks.slice(0, fallbackBudget),
  ]
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
        /** 同一议题下真实存在的 2–4 个立场家族，供取向阶段保留多峰 */
        factionHints: z.array(z.string().min(2).max(60)).max(6).default([]),
        factionGroups: z.array(z.object({
          label: z.string().min(2).max(60),
          answerIds: z.array(z.string().min(1)).max(20).default([]),
          sourceQuotes: z.array(z.string().min(2).max(300)).max(12).default([]),
        })).max(6).default([]),
      }),
    )
    // 上限放宽到 60（实测模型合并后仍可能超过 16）；服务端按契约裁到 15
    .max(60),
})

const MERGE_SYSTEM = [
  '你是「两面」系统的 02 归并 Agent。输入是一批已抽取的判断句（JSON，含来源回答 id）。',
  '硬约束：',
  '1. 先把输入判断按“它们到底在讨论同一个什么问题”聚成少量清晰的共同命题。相同对象、相同核心问题，只是换了说法、换了例子、换了论据、强调了不同后果，都应归到同一个命题。',
  '2. 输出的 text 是中性、具体、可被多方回答的命题，而不是某一派的结论。比如“应该强制标注”“不需要强制标注”“标注会增加成本”都可以围绕同一个命题“AI 生成内容是否应该强制标注”联系起来。',
  '3. 同一命题下的赞成、反对、条件赞成、风险保留、前提质疑，都合并到同一个 judgment；把它们作为不同 faction 交给 03 取向，保留多峰分布。相反结论本身不是拆分理由。',
  '4. 不要把“效率更高”“成本更低”“更容易落地”仅因为论据不同就拆成三个观点：如果它们都在回答同一核心问题，应合并，原话全部作为来源保留。',
  '5. 只有对象、人群、前提条件、时间范围、因果链或价值权衡真正改变，才拆成不同 judgment。不同问题不要为了减少条数硬合并。',
  '6. 禁止用“要综合看”“各有道理”这类宽泛上位句吞掉细分分歧；factionHints 写出该命题下从原话中确认的 2–4 个立场家族，并用 factionGroups 把每个派系对应到 answerIds/sourceQuotes，不要凭空制造派系。',
  '7. 归并前先在脑中做一次“同义改写、上下位表达、论据与结论”的检查：优先得到 6–12 个覆盖面更完整的命题，而不是把每个回答句子各自变成一条。只有确实不同的命题才保留更多条。',
  '8. 合并时保留全部来源：answerIds 必须是被合并判断的原 answerId，sourceQuotes 从被合并判断的 quote 里取。一个 answerId 可以同时参与多个不同 judgment，但同一命题的不同 faction 应留在同一 judgment。',
  '9. 不做立场裁决、不改写含义、不丢弃少数派表述；最终最多 15 条，优先覆盖不同命题，并确保每个命题的主要派系都有来源。',
  '输出 JSON：{"judgments":[{"text":"具体判断","factionHints":["派系A","派系B"],"factionGroups":[{"label":"派系A","answerIds":["回答id"],"sourceQuotes":["原话"]}],"sourceQuotes":["原话"],"answerIds":["回答id"]}]}。',
].join('\n')

/* ---------------------------- 03 取向 Agent ---------------------------- */

const Placement = z.object({
  answerId: z.string().min(1),
  slot: SlotSchema,
  /** 归位理由必须绑定原话，无理由不采纳 */
  reason: z.string().min(4).max(240),
  /** 该答主支持其归位的原话 */
  quote: z.string().min(2).max(300),
  /** 内部派系标签，仅用于校验和日志，不进入 API 契约 */
  faction: z.string().min(2).max(60).optional(),
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
  '3. 先在脑中列出这条判断里 2–4 个真实存在的 faction（立场家族）：例如无条件支持、有条件支持、认为前提不成立、强调代价/风险、主张换一套衡量标准。faction 不是简单的左右标签，必须由原话概括；没有证据的派系不要创造。',
  '4. 再把每条回答按它的主要 faction 归入 1–5 档；同一判断出现两个以上明显峰值时必须保留多峰，不得把少数派全部挤进中间档。条件式、让步式回答可放在中间或偏端，但理由必须引用原话。',
  '5. 允许归入中间档（slot 3），不强迫站边；确实无明确立场的回答直接不要归位。',
  '6. slot 1 = 左端，slot 5 = 右端（scaleDirection 固定 left_to_right，由系统写入，你不用输出）。',
  '7. slot 只表示这条判断内部的相对位置，不具备跨判断语义；不要对 slot 做任何跨判断比较或聚合。',
  '输出 JSON：{"semanticAxis":{"left":"…","right":"…"},"placements":[{"answerId":"…","slot":1,"faction":"派系标签","reason":"…","quote":"…"}]}。',
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
      // ② 查询生成：LLM 语义扩写（原句 + ≤3 个相似问法，2026-09-12 用户拍板，
      //    替代已删除的 8 个机械后缀变体）。扩写失败/超时 → 退回仅原句（expand.degraded）。
      const variants = await expandQueries(question, { signal: ctx.signal })

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
      return kept.map((j) => ({
        text: j.text,
        quote: j.quote,
        answerId: j.answerId,
        topicHint: j.topic,
        factionHint: j.faction,
      }))
    },

    /* ---------------- 02 归并：单路串行 ---------------- */
    async merge(items, ctx) {
      const payload = items.map((it, i) => ({
        id: `x${i + 1}`,
        text: it.text,
        topic: it.topicHint,
        faction: it.factionHint,
        quote: it.quote,
        answerId: it.answerId,
      }))
      const out = await callJson('merge', MergeOut, MERGE_SYSTEM, payload, ctx, 'merge', 120_000)

      const out2 = normalizeMergedJudgments(items, out.judgments ?? [])
      const orphanCount = out2.filter((item) => item.id.startsWith('jfallback')).length
      if (orphanCount > 0) {
        ctx.note('merge.orphan_preserved', { preserved: orphanCount })
      }
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
        factions: judgment.factionHints ?? [],
        factionGroups: judgment.factionGroups ?? [],
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
            position: POSITION_LABEL[d.slot] ?? '中间',
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
