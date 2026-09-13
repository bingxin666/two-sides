import {
  Analysis,
  ERROR_COPY,
  HealthResp,
  HotResp,
  ProgressResp,
  RelatedResp,
  ZhihuAuthStatusResp,
  type Analysis as AnalysisT,
  type ErrorCode,
  type HealthResp as HealthRespT,
  type HotResp as HotRespT,
  type ProgressResp as ProgressRespT,
  type RelatedResp as RelatedRespT,
  type Stage,
  type ZhihuAuthStatusResp as ZhihuAuthStatusT,
} from '@two-sides/contract'

import hotFixture from './fixtures/hot.json'
import kaoyanFixture from './fixtures/analysis-kaoyan.json'
import houseFixture from './fixtures/analysis-house.json'
import timelineFixture from './fixtures/progress-timeline.json'

/**
 * Mock 适配器（VITE_API_MODE=mock）
 *
 * 目标：不开后端也能跑通 N1/N2/N3/T1/失败态五条路径，且数据与契约零漂移
 * —— 所有 fixture 在载入时就用 contract 的 zod schema 校验一遍。
 *
 * 产品入口只有热榜（2026-09-13 收敛，没有搜索端点）。
 *
 * URL 开关（写在 query 上，方便 UI 单独验证某个分支）：
 *   ?mock=fail:quota_exhausted    → getAnalysis 返回一次失败态 202；点「重试」后恢复生成
 *   ?mock=sticky:quota_exhausted  → 一直失败（重试也失败），用来验证不可重试卡片
 *   ?mock=gen                     → 预置题也强制走生成路径（T1 → N2 全流程）
 *   code 取值见 contract 的 ErrorCode：
 *   zhihu_error / quota_exhausted / llm_error / timeout / parse_error
 */

const HOT: HotRespT = HotResp.parse(hotFixture)
/** 离线预览用的假 app_id（真实 app_id 本就公开，但离线不该出现真实值） */
const IS_MOCK_APP_ID = 'mock-app-id'
const ANALYSES: AnalysisT[] = [Analysis.parse(kaoyanFixture), Analysis.parse(houseFixture)]
const READY = new Map(ANALYSES.map((a) => [a.qid, a]))
const TIMELINE: ProgressRespT[] = ProgressResp.array().parse(timelineFixture)

const STAGE_COUNT = 4 // extract / merge / orient / render
const LATENCY_MS = 220

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** 东八区日期键，与后端 §7 一致（显式时区，不依赖运行环境） */
function todayKey(): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date())
}

function hashCode(input: string): number {
  let h = 2166136261
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** 每阶段 1.5–3s 随机（后端文档 §7），按 qid 取种子保证同一题节奏稳定 */
function totalDurationMs(qid: string): number {
  let seed = hashCode(qid)
  const next = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0
    return seed / 0xffffffff
  }
  let total = 0
  for (let i = 0; i < STAGE_COUNT; i += 1) total += 1500 + Math.round(next() * 1500)
  return total
}

const sessions = new Map<string, { startedAt: number; totalMs: number }>()

function sessionFor(qid: string) {
  let s = sessions.get(qid)
  if (!s) {
    s = { startedAt: Date.now(), totalMs: totalDurationMs(qid) }
    sessions.set(qid, s)
  }
  return s
}

/** 走完时间线返回 null，表示「该出快照了」 */
function progressFor(qid: string): ProgressRespT | null {
  const s = sessionFor(qid)
  const elapsed = Date.now() - s.startedAt
  if (elapsed >= s.totalMs) return null
  const idx = Math.min(TIMELINE.length - 1, Math.floor((elapsed / s.totalMs) * TIMELINE.length))
  return TIMELINE[idx]
}

function failed(code: ErrorCode, stage: Stage = 'orient'): ProgressRespT {
  const copy = ERROR_COPY[code]
  return ProgressResp.parse({
    status: 'failed',
    stage,
    stageRatio: 0.4,
    sampleCount: 12,
    judgmentsDone: 5,
    judgmentsTotal: 12,
    error: { code, message: copy.message, retryable: copy.retryable },
  })
}

/* ---------------- URL 开关 ---------------- */

let failCleared = false

function readFlag(): { fail: ErrorCode | null; sticky: boolean; forceGenerate: boolean } {
  const empty = { fail: null, sticky: false, forceGenerate: false }
  if (typeof window === 'undefined') return empty
  const raw = new URLSearchParams(window.location.search).get('mock')
  if (!raw) return empty

  if (raw === 'gen') return { ...empty, forceGenerate: true }

  const [kind, code] = raw.split(':')
  if ((kind === 'fail' || kind === 'sticky') && code) {
    // 非法 code 直接忽略，别让 URL 参数打挂页面
    const legal: ErrorCode[] = ['zhihu_error', 'quota_exhausted', 'llm_error', 'timeout', 'parse_error']
    if (!legal.includes(code as ErrorCode)) return empty
    return { fail: code as ErrorCode, sticky: kind === 'sticky', forceGenerate: false }
  }
  return empty
}

function activeFailCode(): ErrorCode | null {
  const { fail, sticky } = readFlag()
  if (!fail) return null
  if (sticky) return fail
  return failCleared ? null : fail
}

/* ---------------- 方法 ---------------- */

async function getHot(): Promise<HotRespT> {
  await delay(LATENCY_MS)
  return HOT
}

async function getAnalysis(qid: string, title?: string): Promise<AnalysisT | ProgressRespT> {
  await delay(LATENCY_MS)

  const failCode = activeFailCode()
  if (failCode) return failed(failCode)

  const ready = READY.get(qid)
  if (ready && !readFlag().forceGenerate) return ready

  const progress = progressFor(qid)
  if (progress) return progress

  if (ready) return ready

  // 未预置的题：时间线走完后落一份快照（mock 场景下复用模板，qid 换成真实请求的；
  // 带 title 时用它做题面，模拟 titleHint 生成的效果）
  const template = ANALYSES[hashCode(qid) % ANALYSES.length]
  const snapshot = Analysis.parse({ ...template, qid, question: title ?? template.question })
  READY.set(qid, snapshot)
  return snapshot
}

async function retryAnalysis(qid: string, force = false, _title?: string): Promise<ProgressRespT> {
  await delay(LATENCY_MS)

  // 一次性失败标记在重试后清除：模拟冷却结束、重新排队
  failCleared = true

  if (force) sessions.delete(qid)
  else {
    const s = sessions.get(qid)
    if (s) s.startedAt = Date.now()
  }

  const failCode = activeFailCode()
  if (failCode) return failed(failCode, 'extract')

  const progress = progressFor(qid)
  return progress ?? TIMELINE[0]
}

async function getHealth(): Promise<HealthRespT> {
  await delay(120)
  return HealthResp.parse({
    ok: true,
    date: todayKey(),
    quota: { zhihu_search: 4910, hot_list: 99, zhida_openai: 68 },
  })
}

/* ---------------- 增强层 · 登录态与「与你有关」 ---------------- */

/**
 * 离线预览时的登录态。URL 开关 `?mock=authorized` 可切到「已登录」，
 * 并让 getRelated 吐出两条示例标记（第一条热榜题用两种原因、第二条只用一种），
 * 方便单独验证 N1/N2 的标记渲染。
 */
function mockAuthorized(): boolean {
  return typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('mock') === 'authorized'
}

async function getZhihuStatus(): Promise<ZhihuAuthStatusT> {
  await delay(120)
  return ZhihuAuthStatusResp.parse({
    configured: true,
    callbackConfigured: true,
    appId: IS_MOCK_APP_ID,
    redirectUri: 'https://twosides.haori.ink/callback',
    authorized: mockAuthorized(),
    expiresAt: mockAuthorized() ? Date.now() + 3_600_000 : null,
  })
}

/** 未登录 → authorized:false + 空；?mock=authorized → 两条示例标记 */
async function getRelated(qid?: string): Promise<RelatedRespT> {
  await delay(120)
  if (!mockAuthorized()) return RelatedResp.parse({ authorized: false, items: [] })
  const hot = HOT.items.map((i) => i.qid)
  const items = [
    { qid: hot[0], reasons: ['question_favorited', 'answer_favorited'] },
    { qid: hot[1], reasons: ['answer_favorited'] },
  ].filter((i) => Boolean(i.qid))
  if (qid && !items.some((i) => i.qid === qid) && hot.includes(qid)) {
    items.push({ qid, reasons: ['answer_favorited'] })
  }
  return RelatedResp.parse({ authorized: true, items })
}

export const mockApi = {
  getHot,
  getAnalysis,
  retryAnalysis,
  getHealth,
  getZhihuStatus,
  getRelated,
}
