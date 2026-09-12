/**
 * 管线与 Agent 的接口边界 —— D0 定死，D1 只换实现不改签名
 *
 * 分层：
 *   answers  = 内容获取（知乎搜索，D1 真实调用）
 *   extract  = 01 从一批回答抽可争议判断句 + 原话（docs/03 §4.1）
 *   merge    = 02 语义聚类去重
 *   orient   = 03 单条判断生成光谱（两端语义轴 + 五档归位 + 归位理由）
 *   summarize= 04 综述（直答优先，降级 summaryFallback）
 *
 * D0：`agents/fake.ts` 提供确定性实现（不联网、不烧额度）。
 * D1：`agents/llm.ts` 用 llm/provider 实现同一组接口，pipeline.ts 一行切换。
 *
 * 计数口径硬规则见 docs/03 §5.2，出库前统一过 checkCountingRules()。
 */

import type { AuthorityLevel, Judgment, Stage, SummarySource } from '@two-sides/contract'

/** 内容池里的一条回答（由知乎搜索结果归一化而来） */
export interface RawAnswer {
  answerId: string
  /** 回答正文（ContentText） */
  content: string
  authorName: string
  /** AuthorBadgeText（认证文案），无认证时缺省 */
  authorBadge?: string
  /** AuthorityLevel：源字段是 String，归一化时已转 number */
  authority: AuthorityLevel
  voteUp: number
  /** 知乎原文链接：接口自带溯源 UTM，原样透传，禁止改写/去参 */
  url: string
  /** 该回答下「提出不同看法」的精选评论条数（评论无作者字段，按条计） */
  commentChallengeCount?: number
  /** 该回答所属问题页的标题（搜索条目 Title，剥后缀前原样）；薄样本救援合并据此识别同标题新题 */
  questionTitle?: string
}

/** 01 提取的产物：一条可争议判断 + 可定位的原话 */
export interface ExtractedJudgment {
  text: string
  quote: string
  answerId: string
}

/** 02 归并的产物：去重后的判断议题 */
export interface MergedJudgment {
  id: string
  text: string
  sourceQuotes: string[]
  /** 参与该议题的回答 id（供 03 取原文做归位） */
  answerIds: string[]
  /** 相关回答下提出不同看法的精选评论条数（独立字段，不进分布） */
  commentChallengeCount?: number
}

export interface OrientedJudgment extends Judgment {
  /** 便于 04 阶段做综述时取用 */
  relatedAnswerIds: string[]
}

export interface SummarizeResult {
  summary?: string
  source?: SummarySource
}

/** 进度快照（写 jobs 表，主端点直接读） */
export interface PipelineProgress {
  stage: Stage
  /** 0..1，当前阶段内部推进比 */
  stageRatio: number
  sampleCount: number
  judgmentsDone: number
  judgmentsTotal: number
}

export interface PipelineContext {
  qid: string
  date: string
  /**
   * 题目标题提示（可选但强烈建议）。
   * 实测：知乎搜索没有「按 qid 取问题」的能力，纯 qid 搜索会命中无关内容 ——
   * 懒生成路径必须由调用方（预生成 cron 从 hot_list 拿标题，或前端透传）提供标题。
   */
  titleHint?: string
  /** job 超时/取消时 abort；Agent 必须在耗时点检查它 */
  signal: AbortSignal
  /** 上报进度（幂等，可高频调用） */
  report(p: Partial<PipelineProgress>): void
  /** 非致命事件（单批失败等）记录到 job detail，不改变终态 */
  note(event: string, fields?: Record<string, unknown>): void
}

/** 薄样本救援合并的来源题（契约 Analysis.mergedQuestions 元素，2026-09-12 第六次契约演进） */
export interface MergedQuestionInfo {
  qid: string
  title: string
  reason: 'same_title' | 'related'
}

export interface PipelineAgents {
  /**
   * 内容获取：题目标题 + 内容池 + 薄样本救援合并的来源题清单。
   * mergedQuestions 仅在触发救援合并（主池 < 5）且实际并入 ≥1 题时非空，
   * 由 pipeline 原样写入 Analysis.mergedQuestions（契约：禁止静默合并）。
   */
  fetchAnswers(
    qid: string,
    ctx: PipelineContext,
  ): Promise<{
    question: string
    answers: RawAnswer[]
    mergedQuestions?: MergedQuestionInfo[]
  }>

  /** 01 提取：入参是「一批」回答（3–5 条），出参是这批里的判断句 */
  extract(batch: RawAnswer[], ctx: PipelineContext): Promise<ExtractedJudgment[]>

  /** 02 归并：串行，输出去重后的判断议题 */
  merge(items: ExtractedJudgment[], ctx: PipelineContext): Promise<MergedJudgment[]>

  /** 03 取向：每条判断一次调用；返回 null 表示该判断归位失败（部分失败降级） */
  orient(
    judgment: MergedJudgment,
    answers: RawAnswer[],
    ctx: PipelineContext,
  ): Promise<OrientedJudgment | null>

  /**
   * 04 综述：刘看山人格解读（2026-09-12 起外部 LLM 承载，不再走知乎直答）。
   * judgments 为取向完成后的判断列表（含光谱分布与分歧度），供人格如实描述。
   */
  summarize(
    answers: RawAnswer[],
    judgments: OrientedJudgment[],
    ctx: PipelineContext,
  ): Promise<SummarizeResult>
}

export class PipelineError extends Error {
  constructor(
    message: string,
    /** 映射到契约 ErrorCode */
    readonly mapped: 'zhihu_error' | 'quota_exhausted' | 'llm_error' | 'timeout' | 'parse_error',
    /** 失败发生的阶段 */
    readonly stage: Stage,
    readonly retryable: boolean,
  ) {
    super(message)
    this.name = 'PipelineError'
  }
}

/** 可被 abort 的等待；abort 时立即返回，不抛 */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve()
    const t = setTimeout(finish, ms)
    const onAbort = () => {
      clearTimeout(t)
      finish()
    }
    let done = false
    function finish() {
      if (done) return
      done = true
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** 抛 abort 语义的等待：用于需要中断管线的位置 */
export async function delayOrThrow(ms: number, signal?: AbortSignal): Promise<void> {
  await delay(ms, signal)
  if (signal?.aborted) throw new PipelineError('aborted', 'timeout', 'extract', true)
}

/** 简易信号量：扇出阶段控并发（docs/03 §4.1：提取 4、取向 6） */
export class Semaphore {
  private active = 0
  private queue: Array<() => void> = []

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((r) => this.queue.push(r))
    }
    this.active++
    try {
      return await fn()
    } finally {
      this.active--
      this.queue.shift()?.()
    }
  }
}

/** 带信号量的 map：单任务失败按调用方给的 onError 处理，不炸整体 */
export async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  onError: (item: T, index: number, e: unknown) => void,
): Promise<Array<R | null>> {
  const sem = new Semaphore(limit)
  return Promise.all(
    items.map((item, i) =>
      sem.run(async () => {
        try {
          return await fn(item, i)
        } catch (e) {
          onError(item, i, e)
          return null
        }
      }),
    ),
  )
}
