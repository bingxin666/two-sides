/**
 * 环境变量集中读取 —— 唯一允许 process.env 散落的地方之外，其他模块都从这里取
 *
 * 凭证（ZHIHU_ACCESS_SECRET 等）只允许经 process.env 读取，且不得出现在
 * 日志 / 响应 / stack / 注释里。本模块只做读取与派生，不打印值。
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { secretFingerprint } from './log'

/**
 * Bun 的 .env 自动加载只看 cwd：从 apps/server 目录跑（pnpm -F server ...）时，
 * 仓库根的 .env 不会被加载，凭证就会「看起来没配」。
 * 这里显式向上找 .env 并合并进 process.env（只补空缺，不覆盖已注入的值）。
 * 安全：只写入 process.env，绝不打印任何值；路径与内容都不进日志。
 */
function loadDotEnv(): void {
  const candidates = [
    resolve(process.cwd(), '.env'),
    resolve(process.cwd(), '../.env'),
    resolve(process.cwd(), '../../.env'),
  ]
  for (const p of candidates) {
    if (!existsSync(p)) continue
    try {
      const text = readFileSync(p, 'utf8')
      let merged = 0
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim()
        if (!line || line.startsWith('#')) continue
        const eq = line.indexOf('=')
        if (eq <= 0) continue
        const key = line.slice(0, eq).trim()
        let val = line.slice(eq + 1).trim()
        if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        ) {
          val = val.slice(1, -1)
        }
        const cur = process.env[key]
        if (cur === undefined || cur === '') {
          process.env[key] = val
          merged++
        }
      }
      if (merged > 0) {
        // 只报数量，不报路径与内容
        console.log(
          JSON.stringify({ t: new Date().toISOString(), level: 'info', msg: 'env.dotenv.merged', keys: merged }),
        )
      }
      break
    } catch {
      // 读不了就跳过，不阻塞启动
      break
    }
  }
}

loadDotEnv()

function num(name: string, def: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return def
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : def
}

function positiveNum(name: string, def: number): number {
  return Math.max(1, num(name, def))
}

function bool(name: string, def: boolean): boolean {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return def
  return raw === '1' || raw.toLowerCase() === 'true'
}

function str(name: string, def: string): string {
  const raw = process.env[name]
  return raw === undefined || raw === '' ? def : raw
}

function reasoningEffort(name: string, def: 'low' | 'medium' | 'high' | 'xhigh' = 'low'):
  'low' | 'medium' | 'high' | 'xhigh' {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return def
  const value = raw.toLowerCase()
  return value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' ? value : def
}

function pipelineMode(): 'fake' | 'llm' {
  const raw = process.env.PIPELINE_MODE
  // 真实管线是默认路径；fake 只能通过显式 PIPELINE_MODE=fake 开启。
  if (raw === undefined || raw === '') return 'llm'
  if (raw === 'llm' || raw === 'fake') return raw
  throw new Error(`PIPELINE_MODE 必须是 llm 或 fake，当前值无效: ${raw}`)
}

/** 与项目其它位置保持一致：SQLite 路径变量名沿用文档里的 ZHIDUAN_DB_PATH */
export const env = {
  PORT: num('SERVER_PORT', 3000),
  DB_PATH: str('ZHIDUAN_DB_PATH', './data/two-sides.db'),
  PROVIDERS_CONFIG: str('PROVIDERS_CONFIG', 'config/providers.yaml'),

  /** failed 后再试的冷却窗口（秒），防连点打穿额度 */
  RETRY_COOLDOWN_SEC: num('ANALYSIS_RETRY_COOLDOWN_SEC', 60),
  /**
   * 单 job 总时限（秒），超时置 timeout。
   *
   * 2026-09-13：产品入口收敛为热榜（无用户输入）后，单题不再受交互延迟约束 ——
   * 所有可见题目都是 00:30 预生成的预置题，用户点开时已是 ready 快照。
   * 因此把预算从 180s 放宽到 600s，让「更大的样本池 + 更完整的两轮分析」跑得下。
   */
  JOB_TIMEOUT_SEC: num('ANALYSIS_JOB_TIMEOUT_SEC', 600),
  /** 全局 LLM 令牌桶（req/min） */
  /** 全局 LLM 令牌桶上限；并发由各阶段信号量控制，令牌桶负责总吞吐 */
  LLM_RPM_LIMIT: num('LLM_RPM_LIMIT', 1000),
  /** 推理模型思考强度；low 减少延迟与输出 token。 */
  LLM_REASONING_EFFORT: reasoningEffort('LLM_REASONING_EFFORT', 'low'),
  /** 单题提取/取向并发；生产可按供应商承载调节 */
  PIPELINE_EXTRACT_CONCURRENCY: positiveNum('PIPELINE_EXTRACT_CONCURRENCY', 30),
  PIPELINE_ORIENT_CONCURRENCY: positiveNum('PIPELINE_ORIENT_CONCURRENCY', 100),
  /**
   * 单题检索路数上限（1–4）：原句 + LLM 扩写的相似问法。
   * 2026-09-13：全量预生成允许更长单题耗时，把样本池从「单次搜索 ≤10 条」
   * 提到「≤4 路去重 ≤40 条」，判断的光谱才有足够答主把分布铺开。
   * 设 1 = 只用原句（退回旧行为，省 LLM 扩写调用与搜索额度）。
   */
  PIPELINE_QUERY_VARIANTS: Math.min(4, positiveNum('PIPELINE_QUERY_VARIANTS', 4)),
  /** 预生成跨题并发；搜索与 LLM 仍受各自限流约束 */
  PREGENERATE_CONCURRENCY: positiveNum('PREGENERATE_CONCURRENCY', 4),

  /**
   * 是否允许真实知乎调用。默认 false —— D0 绝不能消耗黑客松日额度。
   * 只有显式 ZHIHU_LIVE=1 且凭证已配置时才放行。
   */
  ZHIHU_LIVE: bool('ZHIHU_LIVE', false),
  ZHIHU_ZHIDA_MODEL: str('ZHIHU_ZHIDA_MODEL', 'zhida-thinking-1p5'),

  /** OAuth 增强层：App ID 可公开，App Key 仅服务端使用；token 只进程内存。 */
  ZHIHU_OAUTH_APP_ID: str('ZHIHU_OAUTH_APP_ID', ''),
  ZHIHU_OAUTH_APP_KEY: str('ZHIHU_OAUTH_APP_KEY', ''),
  ZHIHU_OAUTH_REDIRECT_URI: str('ZHIHU_OAUTH_REDIRECT_URI', ''),

  /**
   * 增强层 · 用户收藏扫描（N1/N2 的「与你有关」标记）。
   * 收藏夹按新→旧排序，只需要最近的若干条就能覆盖当日热榜，故默认只扫每个夹第 1 页。
   * 每页 50 条；一次扫描 = 1（收藏夹列表）+ 夹数×页数 次 user_data 调用。
   * user_data 日额度 10000，本功能单用户单次约 6 次，且带 TTL 缓存。
   */
  FAV_SCAN_LISTS: Math.min(20, positiveNum('ZHIHU_FAV_SCAN_LISTS', 5)),
  FAV_SCAN_PAGES: Math.min(3, positiveNum('ZHIHU_FAV_SCAN_PAGES', 1)),
  FAV_PAGE_SIZE: Math.min(50, positiveNum('ZHIHU_FAV_PAGE_SIZE', 50)),
  /** 用户信号缓存 TTL（秒）：同一会话内不重复扫收藏 */
  USER_SIGNAL_TTL_SEC: positiveNum('USER_SIGNAL_TTL_SEC', 600),

  /** 管线实现选择：llm 默认；fake 仅在显式 PIPELINE_MODE=fake 时启用 */
  PIPELINE_MODE: pipelineMode(),
  /** fake 管线总时长（毫秒），留足时间给前端看轮询 */
  PIPELINE_FAKE_DURATION_MS: num('PIPELINE_FAKE_DURATION_MS', 12_000),

  /** 启动时是否重放上一轮未完成的 job */
  RECOVER_ON_BOOT: bool('RECOVER_ON_BOOT', true),

  /** 启动补生成与每日 00:30（Asia/Shanghai）预生成题数；0 关闭自动预生成 */
  PREGENERATE_TOP: num('PREGENERATE_TOP', 30),

  INTERNAL_TOKEN: str('INTERNAL_TOKEN', ''),
} as const

/** 知乎凭证状态（只含指纹，不含值） */
export function zhihuSecretStatus() {
  return secretFingerprint(process.env.ZHIHU_ACCESS_SECRET)
}

/** 某个 env 变量是否已配置（只回布尔，不给值） */
export function hasEnv(name: string): boolean {
  const v = process.env[name]
  return typeof v === 'string' && v.length > 0
}
