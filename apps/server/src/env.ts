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

function bool(name: string, def: boolean): boolean {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return def
  return raw === '1' || raw.toLowerCase() === 'true'
}

function str(name: string, def: string): string {
  const raw = process.env[name]
  return raw === undefined || raw === '' ? def : raw
}

/** 与项目其它位置保持一致：SQLite 路径变量名沿用文档里的 ZHIDUAN_DB_PATH */
export const env = {
  PORT: num('SERVER_PORT', 3000),
  DB_PATH: str('ZHIDUAN_DB_PATH', './data/two-sides.db'),
  PROVIDERS_CONFIG: str('PROVIDERS_CONFIG', 'config/providers.yaml'),

  /** failed 后再试的冷却窗口（秒），防连点打穿额度 */
  RETRY_COOLDOWN_SEC: num('ANALYSIS_RETRY_COOLDOWN_SEC', 60),
  /** 单 job 总时限（秒），超时置 timeout */
  JOB_TIMEOUT_SEC: num('ANALYSIS_JOB_TIMEOUT_SEC', 180),
  /** 全局 LLM 令牌桶（req/min） */
  LLM_RPM_LIMIT: num('LLM_RPM_LIMIT', 60),

  /**
   * 是否允许真实知乎调用。默认 false —— D0 绝不能消耗黑客松日额度。
   * 只有显式 ZHIHU_LIVE=1 且凭证已配置时才放行。
   */
  ZHIHU_LIVE: bool('ZHIHU_LIVE', false),
  ZHIHU_ZHIDA_MODEL: str('ZHIHU_ZHIDA_MODEL', 'zhida-thinking-1p5'),

  /** 管线实现选择：fake（D0 默认，确定性）/ llm（D1 真实调用） */
  PIPELINE_MODE: str('PIPELINE_MODE', 'fake') as 'fake' | 'llm',
  /** fake 管线总时长（毫秒），留足时间给前端看轮询 */
  PIPELINE_FAKE_DURATION_MS: num('PIPELINE_FAKE_DURATION_MS', 12_000),

  /** 启动时是否重放上一轮未完成的 job */
  RECOVER_ON_BOOT: bool('RECOVER_ON_BOOT', true),

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
