/**
 * 两面 · API 契约 —— 前后端唯一事实源
 *
 * 冻结于 D0（2026-09-12）。任何字段变更必须同时改这里 + 通知对侧。
 * 依据：docs/03-后端开发文档.md §5（数据形状 / 计数口径 / 端点）
 *      docs/02-前端开发文档.md §7（API 层）
 *
 * 本文件同时导出 zod schema（运行时校验，后端出口与 mock 入库都用它）
 * 与由 schema 推导出的 TypeScript 类型（编译期）。禁止在别处重复定义同名结构。
 */

import { z } from 'zod'

/* ============================================================
 * 0. 基元
 * ============================================================ */

/** 东八区日期键 "2026-09-08"，所有快照按它主键化 */
export const DateKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD (Asia/Shanghai)')

/** AuthorityLevel：知乎源接口返回 String，入库时必须转 number，参见 §5.1 AuthorRef */
export const AuthorityLevel = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)])

/** 分歧度：纯熵计算，见 §4.3。不用 stance —— 语义上「站队」与本产品定位冲突 */
export const Divergence = z.enum(['low', 'mid', 'high', 'extreme'])

/** 光谱五档。slot 仅在本判断内部有相对语义，跨判断不可比较 */
export const Slot = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)])

export const OrientStatus = z.enum(['done', 'partial'])

/**
 * 综述来源，前端据此展示来源徽标（来源标识不可弱化）。
 * 2026-09-12 产品决策：看山解读改由「刘看山人格」生成（外部 LLM 承载，
 * 不再调用知乎直答 —— 直答 100/日额度瓶颈随之消除）。
 * - liukanshan：刘看山人格生成（当前唯一产出路径），徽标「刘看山解读 · AI 生成」
 * - zhida / fallback：历史快照兼容保留，新数据不再产出
 */
export const SummarySource = z.enum(['zhida', 'fallback', 'liukanshan'])

/** 管线四阶段。failed 时 stage 表示失败发生的阶段 */
export const Stage = z.enum(['extract', 'merge', 'orient', 'render'])

export const JobStatus = z.enum(['pending', 'generating', 'ready', 'failed'])

/** 202 响应里的 status 不会出现 ready（ready 就是 200 + 完整快照） */
export const ProgressStatus = z.enum(['pending', 'generating', 'failed'])

export const ErrorCode = z.enum([
  'zhihu_error',
  'quota_exhausted',
  'llm_error',
  'timeout',
  'parse_error',
  /** 主端点 404：qid 非法或非问答页。不是 job 失败，是请求本身不可满足 —— 前端给「不存在」态，永不给重试按钮 */
  'not_found',
])

/* ============================================================
 * 1. 数据形状
 * ============================================================ */

export const AuthorRef = z.object({
  name: z.string(),
  /** AuthorBadgeText（认证文案），无认证时缺省 */
  badge: z.string().optional(),
  authority: AuthorityLevel,
  quote: z.string(),
  /** 知乎原文链接：接口已带溯源 UTM，前后端一律原样透传，禁止改写 / 去参 / 自行拼接 */
  url: z.string(),
  /** 归位理由 —— 「一切可回溯」硬约束的落点 */
  reason: z.string(),
  voteUp: z.number().int().nonnegative(),
})

/** 仅出现「有人」的档位；空档不出现在数组里，也不画点 */
export const DistributionBucket = z.object({
  slot: Slot,
  authors: z.array(AuthorRef),
})

export const Judgment = z.object({
  id: z.string(),
  text: z.string(),
  /** 答主人数（去重到人），不是条数。与 sampleCount 不同维度，禁止互换 */
  participantCount: z.number().int().nonnegative(),
  divergence: Divergence,
  /** 另有 N 条精选评论提出不同看法：独立字段，不进 divergence、不计入 participantCount */
  commentChallengeCount: z.number().int().nonnegative().optional(),
  orientStatus: OrientStatus,
  /** 本条判断自己的语义轴，由 Agent 推导，不预设正反 */
  semanticAxis: z.object({ left: z.string(), right: z.string() }),
  scaleDirection: z.literal('left_to_right'),
  distribution: z.array(DistributionBucket),
  /** 长度固定 5，本判断内部 L3–L4 答主人数统计 */
  authorityDistribution: z.array(z.number().int().nonnegative()).length(5),
  summary: z.string().optional(),
  summarySource: SummarySource.optional(),
})

export const Analysis = z.object({
  qid: z.string(),
  question: z.string(),
  date: DateKey,
  /** 实际纳入的回答「条数」（不是人数），用于头部诚实声明「基于 N 条回答」 */
  sampleCount: z.number().int().nonnegative(),
  /** Ready analysis can precede its optional background interpretation. Missing = legacy snapshot. */
  summaryStatus: z.enum(['pending', 'ready', 'unavailable']).optional(),
  /** Unique answer counts; unmatched is an explicit model decision, failed is not. */
  classification: z.object({
    matchedAnswerCount: z.number().int().nonnegative(),
    unmatchedAnswerCount: z.number().int().nonnegative(),
    failedAnswerCount: z.number().int().nonnegative(),
  }).optional(),
  /** 10–15 条；participantCount === 0 的判断在后端就被丢弃，不出现在这里 */
  judgments: z.array(Judgment),
  /**
   * 薄样本救援合并的来源题清单（2026-09-12 产品决策，第六次契约演进）。
   * 触发条件：主问题回答池 < 5 条时才启用（富题永不合并，爆炸半径锁死在老冷题）。
   * 两级并入：① 标题归一化后逐字一致（知乎重定向缺失的同题重问）无条件并入；
   * ② 相关题经批量 LLM 关卡裁决「是否同一场讨论」，上限 3 题。
   * 强校验同步放宽为「回答 URL 含主 qid 或任一已批准合并 qid」，语义近似仍然禁止。
   * 前端义务：存在此字段时声明行必须如实标注「已并入 N 个相关提问」—— 禁止静默合并。
   */
  mergedQuestions: z
    .array(
      z.object({
        qid: z.string(),
        title: z.string(),
        reason: z.enum(['same_title', 'related']),
      })
    )
    .max(4)
    .optional(),
})

/* ============================================================
 * 2. 端点响应
 * ============================================================ */

export const HotItem = z.object({ qid: z.string(), title: z.string() })

/** 只含当日已 ready 的预置题（30 条，前端裁 24）；当日无数据 → 404 */
export const HotResp = z.object({
  date: DateKey,
  items: z.array(HotItem),
})

export const ProgressError = z.object({
  code: ErrorCode,
  message: z.string(),
  /** 由服务端判定；前端以它为准决定是否显示重试按钮 */
  retryable: z.boolean(),
})

export const ProgressResp = z.object({
  status: ProgressStatus,
  stage: Stage,
  /** 0..1，当前阶段内部推进比 */
  stageRatio: z.number().min(0).max(1),
  sampleCount: z.number().int().nonnegative(),
  judgmentsDone: z.number().int().nonnegative(),
  judgmentsTotal: z.number().int().nonnegative(),
  error: ProgressError.optional(),
})

export const AnalysisResp = Analysis

export const QuotaResp = z.object({
  /**
   * 三项均为「当日剩余额度」。
   * null = 额度未知 —— 知乎 quota 接口不可达或凭证未配置时 /health 的降级值。
   * 不用 -1 或 0 表达"未知"：0 会被前端渲染成"额度已用尽"，是对用户的撒谎。
   * 前端规则：null → 显示「额度未知」，不参与剩余额度告警逻辑。
   */
  zhihu_search: z.number().int().nonnegative().nullable(),
  hot_list: z.number().int().nonnegative().nullable(),
  zhida_openai: z.number().int().nonnegative().nullable(),
})

export const HealthResp = z.object({
  ok: z.literal(true),
  date: DateKey,
  quota: QuotaResp,
})

/** 增强层 · 光谱另一侧。OAuth 未授权时 403 */
export const OppositeResp = z.object({
  author: AuthorRef,
  mySlot: Slot,
  theirSlot: Slot,
})

/* ---------------- 增强层 · 登录态与「与你有关」 ---------------- */

/**
 * GET /auth/zhihu/status —— 登录态查询（不产生任何知乎调用）。
 * appId / redirectUri 只用于前端诊断展示；二者本就是公开值，
 * **App Key 与用户 token 永不出现在任何响应里**。
 */
export const ZhihuAuthStatusResp = z.object({
  /** 服务端 OAuth 凭证是否齐备（缺则登录按钮不可用，点了也是 503） */
  configured: z.boolean(),
  callbackConfigured: z.boolean(),
  appId: z.string().nullable(),
  redirectUri: z.string().nullable(),
  authorized: z.boolean(),
  /** 会话到期时间（毫秒时间戳）；未登录为 null */
  expiresAt: z.number().nullable(),
})

/**
 * 「这道题与你有关」的判定依据。**只有 id 级精确匹配，没有模糊匹配**：
 * - question_favorited：你收藏过的**问题**（收藏条目 ContentType=question）
 * - answer_favorited：你收藏过的**回答**，且该回答被写进了这道题的光谱
 *
 * 明确不存在「你关注了这个问题」——开放平台没有该接口（`user_followees`
 * 是关注的用户，不是关注的问题）。详见 docs/03 §8.2。
 */
export const RelatedReason = z.enum(['question_favorited', 'answer_favorited'])

export const RelatedItem = z.object({
  qid: z.string(),
  /** 至少一条；无标记的题不出现在 items 里（缺省即「无从判断」，不构成断言） */
  reasons: z.array(RelatedReason).min(1),
})

/**
 * GET /me/related —— 当日热榜题里「与你有关」的那些。
 *
 * 未登录返回 `authorized: false` + 空 items，**用 200 而不是 403**：
 * 前端必须能区分「没登录」（正常，安静降级）与「出错了」（要提示/重试），
 * 403 会把两者混成一个分支。这是对 `/me/opposite` 那套 403 语义的有意偏离。
 *
 * `degraded: true` = 本次没完整取到用户收藏（接口失败/额度），
 * **marks 可能不完整，但不代表「无关」** —— 前端不要据此渲染任何否定文案。
 */
export const RelatedResp = z.object({
  authorized: z.boolean(),
  degraded: z.boolean().optional(),
  items: z.array(RelatedItem),
})

/* ============================================================
 * 3. 统一信封
 * ============================================================ */

/** 成功：{ code, data } */
export function okEnvelope<T extends z.ZodTypeAny>(data: T) {
  return z.object({ code: z.number().int(), data })
}

/** 失败：{ code, message } */
export const ErrEnvelope = z.object({
  code: z.number().int(),
  message: z.string(),
})

/* ============================================================
 * 4.6 产品入口（2026-09-13 第七次契约收敛）
 * ============================================================ */

/**
 * **产品唯一入口是热榜，没有用户输入。**
 *
 * 2026-09-13 用户拍板：废除「输入问题文字 → 搜索候选题 → 懒生成」这条链路。
 * 理由：知乎搜索对任意自由文本的召回不稳定（纯 qid 搜不出、og:title 被风控拦截、
 * global_search 不索引 qid），要靠「薄样本救援合并 + URL 强校验」兜底，复杂度高
 * 而收益不确定；而热榜题每天固定 ≤30 道、可提前预生成，体验与质量都更可控。
 *
 * 因此：GET /search 端点、SearchResp / SearchCandidate 契约、前端输入框全部移除。
 * 「题名 → qid」的解析只剩一处 —— 热榜自带的 {title, url}（question_titles 永久缓存），
 * 冷题（不带 title 且缓存未命中）直接 failed，不做任何反查。
 */

export const HotEnvelope = okEnvelope(HotResp)
export const AnalysisEnvelope = okEnvelope(AnalysisResp)
export const ProgressEnvelope = okEnvelope(ProgressResp)
export const HealthEnvelope = okEnvelope(HealthResp)
export const OppositeEnvelope = okEnvelope(OppositeResp)
export const ZhihuAuthStatusEnvelope = okEnvelope(ZhihuAuthStatusResp)
export const RelatedEnvelope = okEnvelope(RelatedResp)

/* ============================================================
 * 4. 失败文案（前端默认兜底；服务端 error.retryable 优先）
 * ============================================================ */

export const ERROR_COPY: Record<
  z.infer<typeof ErrorCode>,
  { message: string; retryable: boolean }
> = {
  zhihu_error: { message: '知乎接口暂时不可用', retryable: true },
  quota_exhausted: { message: '今日额度已用尽，明天再来', retryable: false },
  llm_error: { message: '分析服务暂时不可用', retryable: true },
  timeout: { message: '生成超时，可重试', retryable: true },
  parse_error: { message: '结果解析异常，可重试', retryable: true },
  not_found: { message: '这个问题不存在，或不是可分析的问答页', retryable: false },
}

/**
 * zhihu_error 的可重试性取决于知乎侧 Code：
 * 30001（频率限制）✅ 可重试 / 20001（鉴权失败）❌ 不可重试。
 * 因此服务端返回 retryable 时以服务端为准，这里只是文案兜底。
 * 前端规则：202 且 status:'failed' → 停止轮询 → 渲染失败卡片；
 *          retryable 为 true 才给「重试」按钮；quota_exhausted 与鉴权失败一律不给。
 */

/* ============================================================
 * 5. 端点路径（一处定义，两端共用）
 * ============================================================ */

export const API_V1 = '/api/v1'

export const ENDPOINTS = {
  /**
   * title 可选：题名提示，仅用于运维/带外跳转（热榜预生成已把题名写进
   * question_titles 永久缓存，正常路径无需携带）。
   * 服务端不完全信任它——抓到的回答 URL 必须含 /question/<qid>/，
   * 一条都没有就 failed，绝不产出答非所问的快照。
   * 无 title 且 question_titles 缓存未命中 → 直接 failed（产品决策：不做任何 qid 反查）。
   */
  analysis: (qid: string, title?: string) => {
    const params = new URLSearchParams()
    if (title) params.set('title', title)
    const qs = params.toString()
    return `${API_V1}/questions/${qid}/analysis${qs ? `?${qs}` : ''}`
  },
  retry: (qid: string, force = false, title?: string) => {
    const params = new URLSearchParams()
    if (force) params.set('force', '1')
    if (title) params.set('title', title)
    const qs = params.toString()
    return `${API_V1}/questions/${qid}/analysis${qs ? `?${qs}` : ''}`
  },
  hot: `${API_V1}/hot`,
  health: `${API_V1}/health`,
  zhihuAuthorize: `${API_V1}/auth/zhihu/authorize`,
  zhihuCallback: `${API_V1}/auth/zhihu/callback`,
  zhihuStatus: `${API_V1}/auth/zhihu/status`,
  zhihuLogout: `${API_V1}/auth/zhihu/logout`,
  meOpposite: (judgmentId: string) => `${API_V1}/me/opposite?judgmentId=${judgmentId}`,
  /**
   * 增强层 · 当日热榜题里「与你有关」的那些（收藏过的题 / 收藏过的回答）。
   * qid 可选：带外直接打开某个问题页时，额外带上它一起判定。
   */
  meRelated: (qid?: string) => {
    const params = new URLSearchParams()
    if (qid) params.set('qid', qid)
    const qs = params.toString()
    return `${API_V1}/me/related${qs ? `?${qs}` : ''}`
  },
} as const

/* ============================================================
 * 6. 计数口径不变量（§5.2，可写成单测断言）
 * ============================================================ */

/**
 * 校验 §5.2 的 9 条硬规则，返回违规描述数组（空数组 = 通过）。
 * 后端写库前、mock fixture 生成后都可以跑一遍，防止口径漂移。
 */
export function checkCountingRules(analysis: z.infer<typeof Analysis>): string[] {
  const errs: string[] = []
  for (const j of analysis.judgments) {
    const all = j.distribution.flatMap((b) => b.authors)
    // 规则 1–3：同一判断内同一答主只计 1 次，且只计有明确 slot 归位者
    const unique = new Set(all.map((a) => a.name))
    if (j.participantCount !== all.length) {
      errs.push(`[${j.id}] Σ distribution[].authors.length !== participantCount`)
    }
    if (unique.size !== all.length) {
      errs.push(`[${j.id}] 同一答主在同一判断中出现多次（应去重到 1 次）`)
    }
    // 规则 4：空档贡献 0 → 不允许出现空 authors 数组
    if (j.distribution.some((b) => b.authors.length === 0)) {
      errs.push(`[${j.id}] 存在空档（authors 为空），应不出现在 distribution 里`)
    }
    // 规则 5
    if (j.authorityDistribution.reduce((a, b) => a + b, 0) > j.participantCount) {
      errs.push(`[${j.id}] Σ authorityDistribution > participantCount`)
    }
    // 规则 6
    if (j.participantCount === 0) {
      errs.push(`[${j.id}] participantCount === 0 的判断应被丢弃，不应出现在 judgments 里`)
    }
    // 规则 7
    if (j.participantCount === 1 && j.divergence !== 'low') {
      errs.push(`[${j.id}] participantCount === 1 时 divergence 必须固定为 low`)
    }
  }
  return errs
}

/* ============================================================
 * 7. 推导类型
 * ============================================================ */

export type DateKey = z.infer<typeof DateKey>
export type AuthorityLevel = z.infer<typeof AuthorityLevel>
export type Divergence = z.infer<typeof Divergence>
export type Slot = z.infer<typeof Slot>
export type OrientStatus = z.infer<typeof OrientStatus>
export type SummarySource = z.infer<typeof SummarySource>
export type Stage = z.infer<typeof Stage>
export type JobStatus = z.infer<typeof JobStatus>
export type ProgressStatus = z.infer<typeof ProgressStatus>
export type ErrorCode = z.infer<typeof ErrorCode>

export type AuthorRef = z.infer<typeof AuthorRef>
export type DistributionBucket = z.infer<typeof DistributionBucket>
export type Judgment = z.infer<typeof Judgment>
export type Analysis = z.infer<typeof Analysis>

export type HotItem = z.infer<typeof HotItem>
export type HotResp = z.infer<typeof HotResp>
export type ProgressError = z.infer<typeof ProgressError>
export type ProgressResp = z.infer<typeof ProgressResp>
export type AnalysisResp = z.infer<typeof AnalysisResp>
export type HealthResp = z.infer<typeof HealthResp>
export type OppositeResp = z.infer<typeof OppositeResp>
export type QuotaResp = z.infer<typeof QuotaResp>
export type ZhihuAuthStatusResp = z.infer<typeof ZhihuAuthStatusResp>
export type RelatedReason = z.infer<typeof RelatedReason>
export type RelatedItem = z.infer<typeof RelatedItem>
export type RelatedResp = z.infer<typeof RelatedResp>
