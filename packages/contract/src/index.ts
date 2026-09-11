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

/** 综述来源必须保留，前端据此双态展示（来源标识不可弱化） */
export const SummarySource = z.enum(['zhida', 'fallback'])

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
  /** 10–15 条；participantCount === 0 的判断在后端就被丢弃，不出现在这里 */
  judgments: z.array(Judgment),
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

export const HotEnvelope = okEnvelope(HotResp)
export const AnalysisEnvelope = okEnvelope(AnalysisResp)
export const ProgressEnvelope = okEnvelope(ProgressResp)
export const HealthEnvelope = okEnvelope(HealthResp)
export const OppositeEnvelope = okEnvelope(OppositeResp)

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
  analysis: (qid: string) => `${API_V1}/questions/${qid}/analysis`,
  retry: (qid: string, force = false) =>
    `${API_V1}/questions/${qid}/analysis${force ? '?force=1' : ''}`,
  hot: `${API_V1}/hot`,
  health: `${API_V1}/health`,
  zhihuAuthorize: `${API_V1}/auth/zhihu/authorize`,
  zhihuCallback: `${API_V1}/auth/zhihu/callback`,
  meOpposite: (judgmentId: string) => `${API_V1}/me/opposite?judgmentId=${judgmentId}`,
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
