/**
 * 手动预生成脚本（D2-1，docs/04）—— cron 之外的人工触发入口
 *
 * 用法（双闸纪律与 pipeline:test 一致：不显式 --live 就拒绝执行，零外部调用）：
 *   bun run pregenerate:run -- --top 6 --live    # 真跑：hot_list 1 次 + 逐题管线
 *   bun run pregenerate:run                      # 打印用法退出
 *
 * 行为：hot_list 取前 N 题 → 逐题走现有 job 机制（INSERT 竞争同路径，titleHint 直给）
 *   → 单题失败标记 failed 并继续，不阻塞批次 → 已 ready 的题幂等跳过。
 * 结束打印批次报告（耗时 / 各计数 / 额度消耗），并用 GET /hot 口径验证 ready 数。
 */

const args = process.argv.slice(2)
const flags = new Set(args.filter((a) => a.startsWith('--')))
const live = flags.has('--live')
const topIdx = args.indexOf('--top')
const topRaw = topIdx >= 0 ? Number(args[topIdx + 1]) : NaN
const topN = Number.isFinite(topRaw) && topRaw >= 1 ? Math.floor(topRaw) : undefined

export {} // 顶层 await 需要模块上下文

if (!live) {
  console.error(
    '用法: bun run pregenerate:run -- [--top N] --live\n' +
      '  双闸纪律：必须显式 --live 才会打开 ZHIHU_LIVE 与真实调用（默认零外部调用）。\n' +
      '  --top 缺省读 PREGENERATE_TOP（默认 30）。',
  )
  process.exit(2)
}

// 双闸：在动态 import 之前设置（env.ts 在模块加载时固化快照）
process.env.ZHIHU_LIVE = '1'
process.env.PIPELINE_MODE = 'llm'

const { pregenerate } = await import('./pregenerate')
const { todayKey } = await import('./time')
const { log } = await import('./log')
const { zhihuCounters } = await import('./zhihu/client')
const { llmCounters } = await import('./agents/llm')
const { listReadyHot } = await import('./repo')

const t0 = performance.now()
try {
  const r = await pregenerate(topN)
  console.log('\n===== 预生成批次报告 =====')
  console.log(JSON.stringify(r, null, 2))
  console.log(`wall=${(performance.now() - t0).toFixed(0)}ms`)
  console.log(
    `额度：hot_list ${zhihuCounters.hotList} 次 | zhihu_search ${zhihuCounters.search} 次 | llm ${llmCounters.calls} 次 / ${llmCounters.tokens} tokens`,
  )
  const ready = listReadyHot(todayKey())
  console.log(`GET /hot 口径（listReadyHot）：${ready.length} 条已 ready`)
  console.log(ready.map((x) => `  - [${x.qid}] ${x.title}`).join('\n'))
} catch (e) {
  console.error(`✗ 预生成失败: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
}

// 静默引用，避免 tree-shake 掉 log 模块的副作用初始化
void log
