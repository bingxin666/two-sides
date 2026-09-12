/**
 * 单题真实全链路验证脚本（glue 的 live 验收入口）
 *
 * 用法：
 *   bun run pipeline:test -- <qid>              # 确定性 fake 管线（零外部调用）
 *   bun run pipeline:test -- <qid> --live       # 真实：知乎搜索 + 四阶段 LLM + 直答
 *   bun run pipeline:test -- <qid> --live --write
 *
 * 输出（stdout）：
 *   1. 各阶段耗时与调用次数
 *   2. 完整 Analysis JSON
 *   3. contract zod + checkCountingRules 校验结果
 *   4. 额度消耗计数（zhihu_search / zhida / llm tokens）
 *
 * 双闸纪律（team-lead 拍板）：默认零外部调用；只有显式 --live 才打开
 * ZHIHU_LIVE=1 与 PIPELINE_MODE=llm。--write 才落库，否则纯跑不写 DB。
 * 测试阶段一次最多 1 题（脚本本身只接受单个 qid），绝不触发 30 题预生成。
 */

import { Analysis as AnalysisSchema, checkCountingRules } from '@two-sides/contract'
import type { PipelineAgents, PipelineContext } from './agents/types'

/* --------------------------------- 参数 --------------------------------- */

const args = process.argv.slice(2)
const flags = new Set(args.filter((a) => a.startsWith('--')))
const positional = args.filter((a) => !a.startsWith('--'))
const qid = positional[0] ?? ''
const live = flags.has('--live')
const write = flags.has('--write')
const fake = flags.has('--fake')
const titleIdx = args.indexOf('--title')
const titleHint = titleIdx >= 0 ? (args[titleIdx + 1] ?? '') : ''

if (!/^\d{1,20}$/.test(qid)) {
  console.error(
    `用法: bun run pipeline:test -- <qid> [--live] [--write] [--fake] [--title "题目标题"]\n  qid 必须是知乎问题 id（纯数字）；llm 模式必须配 --title（产品决策：qid 不做任何反查，无 hint 且缓存 miss 直接 failed）`,
  )
  process.exit(2)
}

// 双闸：在动态 import 之前设置（env.ts 在模块加载时固化快照）
if (live && !fake) {
  process.env.ZHIHU_LIVE = '1'
  process.env.PIPELINE_MODE = 'llm'
} else {
  process.env.ZHIHU_LIVE = '0'
  process.env.PIPELINE_MODE = 'fake'
}
if (write) process.env.ZHIDUAN_DB_PATH ??= './data/two-sides.db'

const { createAgents, runPipeline } = await import('./pipeline')
const { todayKey } = await import('./time')
const { log } = await import('./log')

/* ------------------------------ 阶段计时包装 ------------------------------ */

type StageKey = keyof PipelineAgents
const stageTime: Record<string, { ms: number; calls: number }> = {}
const wallStart = performance.now()

function timed(agents: PipelineAgents): PipelineAgents {
  const wrap = <K extends StageKey>(key: K, fn: PipelineAgents[K]): PipelineAgents[K] => {
    const wrapped = async (...a: Array<unknown>) => {
      const s = performance.now()
      try {
        // @ts-expect-error 动态参数透传
        return await fn(...a)
      } finally {
        const ms = performance.now() - s
        const e = (stageTime[key] ??= { ms: 0, calls: 0 })
        e.ms += ms
        e.calls += 1
      }
    }
    return wrapped as PipelineAgents[K]
  }
  return {
    fetchAnswers: wrap('fetchAnswers', agents.fetchAnswers),
    extract: wrap('extract', agents.extract),
    merge: wrap('merge', agents.merge),
    orient: wrap('orient', agents.orient),
    summarize: wrap('summarize', agents.summarize),
  }
}

/* --------------------------------- 上下文 --------------------------------- */

const controller = new AbortController()
const overallTimer = setTimeout(() => controller.abort(), 180_000)

const ctx: PipelineContext = {
  qid,
  date: todayKey(),
  ...(titleHint ? { titleHint } : {}),
  signal: controller.signal,
  report(p) {
    console.log(
      `[progress] ${p.stage ?? '?'} ratio=${(p.stageRatio ?? 0).toFixed(2)} sample=${p.sampleCount ?? 0} judgments=${p.judgmentsDone ?? 0}/${p.judgmentsTotal ?? 0}`,
    )
  },
  note(event, fields) {
    if (String(event).includes('failed') || String(event).includes('degraded')) {
      console.log(`[note] ${event} ${fields ? JSON.stringify(fields) : ''}`)
    }
  },
}

const date = ctx.date
const result = await runPipeline(timed(createAgents(fake || !live ? 'fake' : 'llm')), ctx)
  .then((a) => ({ ok: true as const, analysis: a }))
  .catch((e) => ({ ok: false as const, error: e }))

clearTimeout(overallTimer)

/* --------------------------------- 报告 --------------------------------- */

console.log('\n===== 阶段耗时 =====')
for (const [k, v] of Object.entries(stageTime)) {
  console.log(`${k.padEnd(14)} ${v.ms.toFixed(0).padStart(6)}ms  ×${v.calls}`)
}
console.log(`${'total'.padEnd(14)} ${(performance.now() - wallStart).toFixed(0).padStart(6)}ms`)

if (!result.ok) {
  const e = result.error as Error & { mapped?: string }
  console.error(`\n✗ 管线失败: ${e?.mapped ?? 'unknown'} — ${e?.message ?? String(result.error)}`)
  process.exit(1)
}

const analysis = result.analysis

console.log('\n===== 计数口径校验 =====')
const counting = checkCountingRules(analysis)
console.log(counting.length === 0 ? '✓ checkCountingRules 零违规' : `✗ ${counting.length} 处违规:`)
for (const v of counting) console.log(`  - ${v}`)

console.log('\n===== 结构校验 =====')
const parsed = AnalysisSchema.safeParse(analysis)
console.log(parsed.success ? '✓ Analysis zod 通过' : `✗ zod: ${parsed.error.issues[0]?.message}`)

console.log('\n===== 额度/调用计数 =====')
const { zhihuCounters, zhidaCounters, llmCounters } = await import('./agents/llm')
console.log(
  `zhihu_search: ${zhihuCounters.search} 次 | zhida: ${zhidaCounters.calls} 次(降级 ${zhidaCounters.degraded}) | llm: ${llmCounters.calls} 次 / ${llmCounters.tokens} tokens`,
)
console.log(` judgments=${analysis.judgments.length} sampleCount=${analysis.sampleCount}`)

console.log('\n===== Analysis JSON =====')
console.log(JSON.stringify(analysis, null, 2))

if (counting.length > 0 || !parsed.success) process.exit(3)

/* --------------------------------- 落库（可选） --------------------------------- */

if (write) {
  const { beginRun, insertJobIgnore, markReady } = await import('./repo')
  const { randomUUID } = await import('node:crypto')
  beginRun(date, qid, 1)
  const jobId = randomUUID()
  insertJobIgnore({ id: jobId, date, qid, stage: 'extract', attempts: 1, owner: 'pipeline-test' })
  markReady(jobId, date, qid, JSON.stringify(analysis), {
    stage: 'render',
    stageRatio: 1,
    sampleCount: analysis.sampleCount,
    judgmentsDone: analysis.judgments.length,
    judgmentsTotal: analysis.judgments.length,
    detail: [{ event: 'pipeline-test', t: new Date().toISOString() }],
  })
  console.log(`\n✓ 已写入当日快照（date=${date} qid=${qid}），可立即用 GET /analysis 验证`)
}

// 静默引用，避免 tree-shake 掉 log 模块的副作用初始化
void log
